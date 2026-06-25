'use client';

import { useEffect, useRef, useState } from 'react';
import type { LogoCorner, LogoPlacementCustom } from '@/lib/types';

/**
 * The visual "Place logo" editor. A modal that shows a TEMPLATE-ADAPTIVE miniature
 * of the brochure cover and lets the user drag + resize the logo anywhere on it,
 * plus opt into a corner running mark on inside pages.
 *
 * Why this is collision-safe: the cover is a fixed full-bleed photo composition in
 * the engine, so a logo placed anywhere over it never collides with flowed content.
 * The inside mark is constrained to a page CORNER with a bounded size — the engine
 * renders it as a zero-flow-height overlay, so it can never push content, add a
 * page, or cause a pagination error. The numbers produced here are re-clamped on
 * the server (`sanitizeBrandKit`) before they ever reach the renderer.
 */

type Family = 'banded' | 'editorial';

// Bounds kept in lock-step with the server clamps (brand-kit.ts) + engine.
const COVER = { min: 0.08, max: 0.5, dflt: 0.24 };
const INNER = { min: 0.06, max: 0.3, dflt: 0.12 };
const COVER_DEFAULT = { x: 0.5, y: 0.3, scale: COVER.dflt };
const INNER_DEFAULT: { corner: LogoCorner; scale: number } = { corner: 'top-left', scale: INNER.dflt };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// 6 edge anchors (a running mark belongs at a page EDGE — placing it over the body
// text area would overlap content on every page). `pos` positions it on the mock.
const CORNERS: { key: LogoCorner; label: string; pos: string }[] = [
  { key: 'top-left', label: 'Top L', pos: 'left-1 top-1' },
  { key: 'top-center', label: 'Top C', pos: 'left-1/2 -translate-x-1/2 top-1' },
  { key: 'top-right', label: 'Top R', pos: 'right-1 top-1' },
  { key: 'bottom-left', label: 'Bot L', pos: 'left-1 bottom-1' },
  { key: 'bottom-center', label: 'Bot C', pos: 'left-1/2 -translate-x-1/2 bottom-1' },
  { key: 'bottom-right', label: 'Bot R', pos: 'right-1 bottom-1' },
];

export function LogoPlacer({
  logoUrl,
  family,
  templateName,
  accent,
  brandName,
  value,
  onSave,
  onClose,
}: {
  logoUrl: string;
  family: Family;
  templateName: string;
  accent: string;
  brandName?: string;
  value: LogoPlacementCustom | null;
  onSave: (v: LogoPlacementCustom | null) => void;
  onClose: () => void;
}) {
  // Show the REAL agency name in the cover mock (truncated) so its length is visible
  // — the engine wraps/yields it beside the logo at render time, logo always wins.
  const agencyText = (brandName || 'Agency').toUpperCase();

  // Banded (TMC Press) places the logo in a TOP HEADER (left / centre / right) — the
  // section header reserves space below it. Editorial reserves a strip and supports all
  // six positions. Offer only the zones that render cleanly for the chosen template.
  const insideZones = family === 'banded' ? CORNERS.filter((z) => z.key.startsWith('top')) : CORNERS;
  const [showCover, setShowCover] = useState(value ? !!value.cover : true);
  const [cover, setCover] = useState(value?.cover ?? COVER_DEFAULT);
  const [showInner, setShowInner] = useState(!!value?.interior);
  const [inner, setInner] = useState(value?.interior ?? INNER_DEFAULT);
  // Backing defaults to AS-UPLOADED (transparent) so the logo is used exactly as
  // given — no auto white box. The user can add a white plate for busy photos.
  const [backing, setBacking] = useState<'none' | 'plate'>(value?.backing ?? 'none');
  const plated = backing === 'plate';
  // Frosted-plate vs bare preview, mirroring the engine (.bare = soft drop-shadow).
  const plateBox = plated ? 'bg-white/90 shadow-md' : '';
  const bareShadow = plated ? undefined : 'drop-shadow(0 2px 9px rgba(0,0,0,.55))';

  const canvasRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<null | 'move' | 'resize'>(null);
  const dragOffset = useRef({ dx: 0, dy: 0 });

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Keep the inside corner valid for the chosen template (banded → top header only;
  // a bottom zone maps up to the matching top position, centre stays centre).
  useEffect(() => {
    if (family === 'banded' && !inner.corner.startsWith('top')) {
      setInner((s) => ({
        ...s,
        corner: s.corner.endsWith('left') ? 'top-left' : s.corner.endsWith('right') ? 'top-right' : 'top-center',
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [family]);

  function norm(e: React.PointerEvent) {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0.5, y: 0.5 };
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
  }

  function startMove(e: React.PointerEvent) {
    e.preventDefault();
    const { x, y } = norm(e);
    dragOffset.current = { dx: cover.x - x, dy: cover.y - y };
    gesture.current = 'move';
    canvasRef.current?.setPointerCapture(e.pointerId);
  }
  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    gesture.current = 'resize';
    canvasRef.current?.setPointerCapture(e.pointerId);
  }
  function onMove(e: React.PointerEvent) {
    if (!gesture.current) return;
    const { x, y } = norm(e);
    if (gesture.current === 'move') {
      setCover((c) => ({
        ...c,
        x: clamp(x + dragOffset.current.dx, 0.05, 0.95),
        y: clamp(y + dragOffset.current.dy, 0.05, 0.95),
      }));
    } else {
      setCover((c) => ({ ...c, scale: clamp(Math.abs(x - c.x) * 2, COVER.min, COVER.max) }));
    }
  }
  function endGesture(e: React.PointerEvent) {
    gesture.current = null;
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  function save() {
    const result: LogoPlacementCustom = {
      cover: showCover ? cover : null,
      interior: showInner ? inner : null,
      backing,
    };
    onSave(result.cover || result.interior ? result : null);
  }

  // Faux content bars for the inside-page mock.
  const innerBars = ['85%', '70%', '92%', '60%', '78%', '88%', '52%'];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-edge bg-panel p-5 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-start justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">Place your logo</h3>
            <p className="text-[11px] text-muted">
              Layout previews the <span className="text-slate-200">{templateName}</span> template · drag &amp; resize on
              the cover, then optionally pin a corner mark inside.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-muted hover:bg-edge hover:text-slate-200"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="mt-3 grid gap-5 md:grid-cols-[260px_1fr]">
          {/* ---- Cover canvas ---- */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-medium text-slate-200">Cover</span>
              <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-muted">
                <input
                  type="checkbox"
                  checked={showCover}
                  onChange={(e) => setShowCover(e.target.checked)}
                  className="accent-accent"
                />
                show logo on cover
              </label>
            </div>
            <div
              ref={canvasRef}
              onPointerMove={onMove}
              onPointerUp={endGesture}
              onPointerCancel={endGesture}
              className="relative aspect-[210/297] w-full touch-none select-none overflow-hidden rounded-lg border border-edge"
              style={{ opacity: showCover ? 1 : 0.4 }}
            >
              {/* Template-adaptive cover mock */}
              {family === 'editorial' ? (
                <>
                  <div className="absolute inset-0 bg-gradient-to-b from-stone-500 via-stone-700 to-stone-900" />
                  <div className="absolute inset-2 border border-white/40" />
                  <div className="absolute inset-[9px] border border-white/15" />
                  <div className="absolute inset-x-0 top-0 flex justify-between gap-2 px-4 pt-3 text-[5px] uppercase tracking-[0.35em] text-white/70">
                    <span className="max-w-[55%] truncate">{agencyText}</span>
                    <span>Edition</span>
                  </div>
                  <div className="absolute inset-x-4 bottom-9 space-y-1.5">
                    <div className="h-3 w-4/5 rounded-sm bg-white/90" />
                    <div className="h-[3px] w-8 rounded-sm" style={{ background: accent }} />
                    <div className="h-1.5 w-1/2 rounded-sm bg-white/55" />
                  </div>
                </>
              ) : (
                <>
                  <div className="absolute inset-0 bg-gradient-to-b from-slate-600 via-slate-900 to-black" />
                  <div
                    className="absolute left-1/2 top-[46%] -translate-x-1/2 -translate-y-1/2 rounded-full"
                    style={{ width: '70%', aspectRatio: '1 / 1', background: accent, opacity: 0.82 }}
                  />
                  <div className="absolute inset-x-0 top-0 flex justify-between gap-2 px-3 pt-2 text-[6px] uppercase tracking-[0.2em] text-white/75">
                    <span className="max-w-[55%] truncate">{agencyText}</span>
                    <span>2026</span>
                  </div>
                  <div className="absolute inset-x-3 bottom-7 space-y-1">
                    <div className="h-2.5 w-3/5 rounded-sm bg-white/90" />
                    <div className="h-2.5 w-2/5 rounded-sm bg-white/90" />
                    <div className="mt-1 h-1 w-1/3 rounded-sm bg-white/50" />
                  </div>
                </>
              )}

              {/* Draggable logo */}
              {showCover && (
                <div
                  onPointerDown={startMove}
                  className={`absolute flex cursor-grab items-center justify-center rounded-[2px] active:cursor-grabbing ${plateBox} ${plated ? 'p-1' : ''}`}
                  style={{
                    left: `${cover.x * 100}%`,
                    top: `${cover.y * 100}%`,
                    width: `${cover.scale * 100}%`,
                    transform: 'translate(-50%, -50%)',
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={logoUrl}
                    alt="logo"
                    className="pointer-events-none block h-auto w-full object-contain"
                    style={{ filter: bareShadow }}
                  />
                  {/* resize handle */}
                  <span
                    onPointerDown={startResize}
                    className="absolute -bottom-1.5 -right-1.5 h-3.5 w-3.5 cursor-nwse-resize rounded-full border-2 border-white bg-accent shadow"
                    title="Drag to resize"
                  />
                </div>
              )}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="w-9 text-[10px] text-muted">Size</span>
              <input
                type="range"
                min={COVER.min}
                max={COVER.max}
                step={0.01}
                value={cover.scale}
                disabled={!showCover}
                onChange={(e) => setCover((c) => ({ ...c, scale: Number(e.target.value) }))}
                className="h-1 flex-1 cursor-pointer accent-accent disabled:opacity-40"
              />
              <span className="w-8 text-right text-[10px] tabular-nums text-muted">{Math.round(cover.scale * 100)}%</span>
            </div>

            {/* Backing — default "as uploaded" so the logo is used exactly as given. */}
            <div className="mt-2 flex items-center gap-2">
              <span className="w-9 text-[10px] text-muted">Backing</span>
              <div className="flex overflow-hidden rounded-md border border-edge text-[10px]">
                {(['none', 'plate'] as const).map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => setBacking(b)}
                    className={`px-2 py-1 ${
                      backing === b ? 'bg-accent/20 text-slate-100' : 'bg-ink text-muted hover:text-slate-200'
                    }`}
                  >
                    {b === 'none' ? 'As uploaded' : 'White plate'}
                  </button>
                ))}
              </div>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-muted">
              {plated
                ? 'A white box sits behind the logo — helps a light/thin logo stay legible on busy photos.'
                : 'Logo used exactly as uploaded — transparency kept, no box (a soft shadow keeps it readable).'}
            </p>
          </div>

          {/* ---- Inside pages ---- */}
          <div>
            <label className="mb-1.5 flex cursor-pointer items-center gap-2 text-[11px] font-medium text-slate-200">
              <input
                type="checkbox"
                checked={showInner}
                onChange={(e) => setShowInner(e.target.checked)}
                className="accent-accent"
              />
              Also place a mark on inside pages
            </label>
            <p className="mb-2 text-[10px] leading-relaxed text-muted">
              The inside mark snaps to a corner and the engine reserves that space, so content always reflows cleanly —
              no overlaps, empty pages or pagination errors.
            </p>

            <div className={showInner ? '' : 'pointer-events-none opacity-40'}>
              <div className="flex items-start gap-4">
                {/* inside-page mock with 4 corner zones */}
                <div className="relative aspect-[210/297] w-[120px] shrink-0 overflow-hidden rounded-md border border-edge bg-white">
                  <div className="absolute inset-x-3 top-4 space-y-1.5">
                    {innerBars.map((w, i) => (
                      <div key={i} className="h-1 rounded-sm bg-slate-300" style={{ width: w }} />
                    ))}
                  </div>
                  {insideZones.map((cn) => {
                    const selected = inner.corner === cn.key;
                    return (
                      <button
                        key={cn.key}
                        type="button"
                        onClick={() => setInner((s) => ({ ...s, corner: cn.key }))}
                        className={`absolute ${cn.pos} flex h-5 w-5 items-center justify-center rounded-[3px] text-[8px] transition ${
                          selected
                            ? 'bg-accent text-ink ring-2 ring-accent/40'
                            : 'bg-slate-200 text-slate-500 hover:bg-slate-300'
                        }`}
                        title={cn.key}
                      >
                        {cn.label.split(' ')[1] ?? cn.label}
                      </button>
                    );
                  })}
                  {/* selected-corner logo preview (click-through so the corner button stays selectable) */}
                  <div
                    className={`pointer-events-none absolute ${
                      CORNERS.find((c) => c.key === inner.corner)?.pos ?? 'left-1 top-1'
                    } flex items-center justify-center rounded-[2px] ${plated ? 'bg-white/90 p-0.5 shadow' : ''}`}
                    style={{ width: `${inner.scale * 100}%` }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={logoUrl} alt="" className="block h-auto w-full object-contain" style={{ filter: bareShadow }} />
                  </div>
                </div>

                <div className="flex-1 space-y-3 pt-1">
                  <div>
                    <span className="text-[10px] text-muted">
                      Position{family === 'banded' ? ' · header (left / centre / right)' : ''}
                    </span>
                    <div className="mt-1 grid grid-cols-3 gap-1.5">
                      {insideZones.map((cn) => (
                        <button
                          key={cn.key}
                          type="button"
                          onClick={() => setInner((s) => ({ ...s, corner: cn.key }))}
                          className={`rounded-md border px-1.5 py-1 text-[10px] ${
                            inner.corner === cn.key
                              ? 'border-accent bg-accent/15 text-slate-100'
                              : 'border-edge bg-ink text-muted hover:text-slate-200'
                          }`}
                        >
                          {cn.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-9 text-[10px] text-muted">Size</span>
                    <input
                      type="range"
                      min={INNER.min}
                      max={INNER.max}
                      step={0.01}
                      value={inner.scale}
                      onChange={(e) => setInner((s) => ({ ...s, scale: Number(e.target.value) }))}
                      className="h-1 flex-1 cursor-pointer accent-accent"
                    />
                    <span className="w-8 text-right text-[10px] tabular-nums text-muted">
                      {Math.round(inner.scale * 100)}%
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ---- Footer actions ---- */}
        <div className="mt-5 flex items-center justify-between border-t border-edge pt-3">
          <button
            type="button"
            onClick={() => onSave(null)}
            className="text-[11px] text-muted underline underline-offset-2 hover:text-slate-200"
            title="Clear custom placement — the prompt / automatic placement takes over"
          >
            Reset to automatic
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-edge px-3 py-1.5 text-xs text-slate-200 hover:bg-edge"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              className="rounded-lg bg-gradient-to-r from-accent to-accent2 px-4 py-1.5 text-xs font-semibold text-ink hover:opacity-95"
            >
              Save placement
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
