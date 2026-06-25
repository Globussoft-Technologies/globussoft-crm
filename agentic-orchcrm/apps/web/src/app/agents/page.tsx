'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card, EmptyState, PageHeader, Spinner } from '@/components/ui';
import type { UiPack } from '@/lib/types';

export default function AgentsPage() {
  const [packs, setPacks] = useState<UiPack[] | null>(null);
  const [sectorKey, setSectorKey] = useState('');

  useEffect(() => {
    // Mirror the Command Center: prefer the configured default sector.
    Promise.all([
      fetch('/api/sectors').then((r) => r.json()),
      fetch('/api/config').then((r) => r.json()).catch(() => null),
    ])
      .then(([s, c]) => {
        const list = (s as { packs: UiPack[] }).packs ?? [];
        setPacks(list);
        const preferred = (c as { orchestration?: { defaultSector?: string } } | null)
          ?.orchestration?.defaultSector;
        const initial = preferred && list.some((p) => p.key === preferred) ? preferred : list[0]?.key;
        if (initial) setSectorKey(initial);
      })
      .catch(() => setPacks([]));
  }, []);

  const pack = useMemo(() => packs?.find((p) => p.key === sectorKey), [packs, sectorKey]);

  return (
    <>
      <PageHeader
        title="Agents"
        subtitle="The agent roster per sector pack. Editing & versioning is the next milestone."
      />

      {packs === null ? (
        <Card><Spinner label="Loading agents…" /></Card>
      ) : packs.length === 0 ? (
        <Card><EmptyState title="No sector packs found" /></Card>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap gap-2">
            {packs.map((p) => (
              <button
                key={p.key}
                onClick={() => setSectorKey(p.key)}
                className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                  p.key === sectorKey
                    ? 'border-accent/50 bg-accent/10 text-slate-100'
                    : 'border-edge bg-panel text-muted hover:text-slate-200'
                }`}
              >
                {p.name}
                <span className="ml-2 text-xs text-muted">{p.agents.length}</span>
              </button>
            ))}
          </div>

          {pack && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {pack.agents.map((a) => {
                const isCoordinator = a.key === pack.coordinatorKey;
                return (
                  <Card key={a.key} className={isCoordinator ? 'border-accent/40' : ''}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-[10px] font-medium tracking-widest text-muted">{a.title}</div>
                        <h3 className="mt-0.5 font-semibold text-slate-100">{a.name}</h3>
                      </div>
                      {isCoordinator && (
                        <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
                          COORDINATOR
                        </span>
                      )}
                    </div>
                    <p className="mt-2 text-sm text-muted">{a.description}</p>
                    <dl className="mt-3 space-y-1.5 border-t border-edge/60 pt-3 text-xs">
                      <Row k="Capability tier" v={a.tier} />
                      <Row k="Tools" v={a.tools.length ? a.tools.join(', ') : 'none'} />
                      {a.delegatesTo.length > 0 && <Row k="Delegates to" v={a.delegatesTo.join(', ')} />}
                      <Row k="Key" v={a.key} mono />
                    </dl>
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}
    </>
  );
}

function Row({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{k}</dt>
      <dd className={`truncate text-right text-slate-300 ${mono ? 'font-mono' : ''}`}>{v}</dd>
    </div>
  );
}
