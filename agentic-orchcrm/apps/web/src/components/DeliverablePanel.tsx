'use client';

import { Card, EmptyState } from '@/components/ui';
import { extractArtifact } from '@/lib/artifact';

/**
 * Renders a run's final deliverable. If the deliverable is a generated file
 * (e.g. a travel brochure PDF), it shows a live preview + download button;
 * otherwise it shows the text.
 */
export function DeliverablePanel({
  result,
  running,
  error,
  title = 'Final deliverable',
  actions,
}: {
  result?: string;
  running?: boolean;
  error?: string;
  title?: string;
  actions?: React.ReactNode;
}) {
  const artifact = extractArtifact(result);

  return (
    <Card title={title} actions={actions}>
      {error ? (
        <div className="rounded-lg border border-bad/40 bg-bad/10 p-3 text-sm text-bad">{error}</div>
      ) : artifact ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm text-slate-200">
              <span className="rounded-md bg-accent/15 px-2 py-0.5 text-xs font-semibold uppercase text-accent">
                {artifact.type}
              </span>
              {artifact.filename}
            </span>
            <a
              href={artifact.url}
              download={artifact.filename}
              className="rounded-lg bg-gradient-to-r from-accent to-accent2 px-3 py-1.5 text-xs font-semibold text-ink transition hover:opacity-95"
            >
              ↓ Download
            </a>
          </div>
          <iframe
            title="Deliverable preview"
            src={artifact.url}
            // Sandbox the HTML fallback (no allow-scripts) so any script that
            // slipped past sanitizeHtml can't run in our origin. PDFs render via
            // the browser's native viewer and don't need (or get) a sandbox.
            sandbox={artifact.type === 'html' ? '' : undefined}
            className="h-[36rem] w-full rounded-lg border border-edge bg-white"
          />
        </div>
      ) : result ? (
        <pre className="scroll-thin max-h-[32rem] overflow-auto whitespace-pre-wrap text-sm text-slate-200">
          {result}
        </pre>
      ) : (
        <EmptyState
          title={running ? 'Working…' : 'No deliverable yet'}
          hint={running ? 'The CEO is coordinating specialists.' : 'Assign a goal to begin.'}
        />
      )}
    </Card>
  );
}
