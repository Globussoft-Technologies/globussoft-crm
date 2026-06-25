'use client';

import { useEffect, useRef, useState } from 'react';
import type { LogoPlacementCustom, UiPack } from '@/lib/types';
import { LogoPlacer } from './LogoPlacer';

/** What the brand-kit panel collects (all optional). Mirrors the server sanitizer. */
export interface BrandInput {
  logoUrl?: string; // base64 data: URI of the uploaded logo
  name?: string;
  tagline?: string;
  contact?: string[];
  socials?: string[];
  colors?: { accent?: string };
  onDark?: boolean;
  /** Exact logo placement from the visual placer (overrides prompt-parsed placement). */
  custom?: LogoPlacementCustom;
}

const MAX_LOGO_BYTES = 120 * 1024;

/**
 * The single human touch-point: pick a sector and hand ONE goal to the CEO.
 * For sectors that produce a branded deliverable (e.g. travel brochures) an
 * OPTIONAL "Brand kit" lets the user upload a logo + fill agency details once.
 * Everything is optional — leave it blank and the engine works exactly as before
 * (accent auto-inferred from the destination, text wordmark, etc.).
 */
export function CommandConsole({
  packs,
  sectorKey,
  onSectorChange,
  onSubmit,
  running,
}: {
  packs: UiPack[];
  sectorKey: string;
  onSectorChange: (key: string) => void;
  onSubmit: (goal: string, styleKey?: string, brand?: BrandInput) => void;
  running: boolean;
}) {
  const [goal, setGoal] = useState('');
  const active = packs.find((p) => p.key === sectorKey);
  const [styleKey, setStyleKey] = useState('auto');

  // Brand kit (optional). Only surfaced for sectors that offer styles (branded output).
  const [brandOpen, setBrandOpen] = useState(false);
  const [logoUrl, setLogoUrl] = useState<string | undefined>();
  const [logoName, setLogoName] = useState<string | undefined>();
  const [logoErr, setLogoErr] = useState<string | undefined>();
  const [brandName, setBrandName] = useState('');
  const [accent, setAccent] = useState('');
  const [contact, setContact] = useState('');
  const [socials, setSocials] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Visual logo placer (optional). null → fall back to prompt-driven placement.
  const [placement, setPlacement] = useState<LogoPlacementCustom | null>(null);
  const [placerOpen, setPlacerOpen] = useState(false);

  // The concrete template that will render → drives the placer's adaptive mock.
  const family: 'banded' | 'editorial' = styleKey === 'editorial-sakura' ? 'editorial' : 'banded';
  const templateName = family === 'editorial' ? 'Editorial Sakura' : 'TMC Press';
  const mockAccent = /^#[0-9a-fA-F]{6}$/.test(accent.trim()) ? accent.trim() : '#0e6b4f';

  const hasBrandKit = !!active?.styles?.length;

  // Reset the style to the new sector's default whenever the sector changes, so a
  // stale style is never carried to (or sent for) a different sector.
  useEffect(() => {
    setStyleKey(active?.defaultStyleKey ?? 'auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectorKey]);

  function onLogoPick(file?: File) {
    setLogoErr(undefined);
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
      setLogoErr('Use a PNG, JPG, WebP or GIF (SVG isn’t supported).');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoErr('Logo must be under 120 KB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setLogoUrl(typeof reader.result === 'string' ? reader.result : undefined);
      setLogoName(file.name);
    };
    reader.onerror = () => setLogoErr('Could not read that file.');
    reader.readAsDataURL(file);
  }

  function clearLogo() {
    setLogoUrl(undefined);
    setLogoName(undefined);
    setLogoErr(undefined);
    setPlacement(null); // a placement without a logo is meaningless
    setPlacerOpen(false);
    if (fileRef.current) fileRef.current.value = '';
  }

  function buildBrand(): BrandInput | undefined {
    if (!hasBrandKit) return undefined;
    const contactLines = contact
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const socialSlugs = socials
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const b: BrandInput = {
      ...(logoUrl ? { logoUrl } : {}),
      ...(brandName.trim() ? { name: brandName.trim() } : {}),
      ...(contactLines.length ? { contact: contactLines } : {}),
      ...(socialSlugs.length ? { socials: socialSlugs } : {}),
      ...(/^#[0-9a-fA-F]{3,8}$/.test(accent.trim()) ? { colors: { accent: accent.trim() } } : {}),
      // Custom placement only matters with a logo to place.
      ...(logoUrl && placement ? { custom: placement } : {}),
    };
    return Object.keys(b).length ? b : undefined;
  }

  return (
    <div className="rounded-2xl border border-edge bg-panel p-5 shadow-card">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-100">Assign a goal to the CEO</h3>
        <div className="flex items-center gap-2">
          {!!active?.styles?.length && (
            <select
              value={styleKey}
              onChange={(e) => setStyleKey(e.target.value)}
              disabled={running}
              title="Design style"
              className="rounded-lg border border-edge bg-ink px-2.5 py-1.5 text-sm text-slate-200 outline-none focus:border-accent"
            >
              {active.styles.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          )}
          <select
            value={sectorKey}
            onChange={(e) => onSectorChange(e.target.value)}
            disabled={running}
            className="rounded-lg border border-edge bg-ink px-2.5 py-1.5 text-sm text-slate-200 outline-none focus:border-accent"
          >
            {packs.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {active && <p className="mb-3 text-xs text-muted">{active.description}</p>}

      <textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        disabled={running}
        rows={5}
        placeholder="e.g. Write a 1-page brief on the competitive landscape for AI orchestration tools."
        className="w-full resize-none rounded-xl border border-edge bg-ink p-3 text-sm text-slate-100 outline-none placeholder:text-muted/70 focus:border-accent"
      />

      {hasBrandKit && (
        <div className="mt-3 rounded-xl border border-edge bg-ink/60">
          <button
            type="button"
            onClick={() => setBrandOpen((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm font-medium text-slate-200"
          >
            <span className="flex items-center gap-2">
              Brand kit
              <span className="rounded-md bg-edge px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                optional
              </span>
              {(logoUrl || brandName || accent || contact || socials) && (
                <span className="h-1.5 w-1.5 rounded-full bg-accent" title="Brand details set" />
              )}
            </span>
            <span className="text-muted">{brandOpen ? '–' : '+'}</span>
          </button>

          {brandOpen && (
            <div className="space-y-3 border-t border-edge px-3 pb-3 pt-3">
              <p className="text-[11px] leading-relaxed text-muted">
                All optional. Upload a logo to brand the brochure (else a text wordmark is used). Leave colours blank to
                auto-match the destination. By default the prompt decides where the logo goes — e.g. “put the logo
                top-left”, “logo on every page”, “big logo on the cover”. Or upload one and hit{' '}
                <span className="text-slate-300">Place logo</span> to position it visually.
              </p>

              {/* Logo upload */}
              <div className="flex items-center gap-3">
                {logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={logoUrl}
                    alt="logo preview"
                    className="h-10 w-10 rounded-md border border-edge bg-white object-contain p-1"
                  />
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded-md border border-dashed border-edge text-[10px] text-muted">
                    logo
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    disabled={running}
                    onChange={(e) => onLogoPick(e.target.files?.[0])}
                    className="text-xs text-slate-300 file:mr-2 file:rounded-md file:border-0 file:bg-edge file:px-2 file:py-1 file:text-xs file:text-slate-200"
                  />
                  <span className="text-[10px] text-muted">
                    PNG / JPG / WebP / GIF · under 120 KB
                    {logoName ? ` · ${logoName}` : ''}
                  </span>
                  {logoUrl && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setPlacerOpen(true)}
                        disabled={running}
                        className="self-start rounded-md border border-accent/60 bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-slate-100 hover:bg-accent/20 disabled:opacity-40"
                      >
                        {placement ? 'Edit placement' : 'Place logo'}
                      </button>
                      {placement && (
                        <button
                          type="button"
                          onClick={() => setPlacement(null)}
                          className="text-[10px] text-muted underline"
                          title="Use prompt / automatic placement instead"
                        >
                          auto
                        </button>
                      )}
                      <button type="button" onClick={clearLogo} className="text-[10px] text-muted underline">
                        remove
                      </button>
                    </div>
                  )}
                  {placement && (
                    <span className="text-[10px] text-accent">
                      Custom placement set
                      {placement.cover ? ` · cover ${Math.round(placement.cover.scale * 100)}%` : ' · not on cover'}
                      {placement.interior ? ` · inside ${placement.interior.corner.replace('-', ' ')}` : ''}
                    </span>
                  )}
                </div>
              </div>
              {logoErr && <div className="text-[11px] text-bad">{logoErr}</div>}

              <div className="grid grid-cols-2 gap-2">
                <input
                  value={brandName}
                  onChange={(e) => setBrandName(e.target.value)}
                  disabled={running}
                  placeholder="Agency name"
                  className="rounded-lg border border-edge bg-ink px-2.5 py-1.5 text-sm text-slate-100 outline-none placeholder:text-muted/70 focus:border-accent"
                />
                <div className="flex items-center gap-2 rounded-lg border border-edge bg-ink px-2.5 py-1.5">
                  <input
                    type="color"
                    value={/^#[0-9a-fA-F]{6}$/.test(accent) ? accent : '#0e6b4f'}
                    onChange={(e) => setAccent(e.target.value)}
                    disabled={running}
                    title="Brand accent (optional)"
                    className="h-5 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
                  />
                  <input
                    value={accent}
                    onChange={(e) => setAccent(e.target.value)}
                    disabled={running}
                    placeholder="Accent #hex (auto)"
                    className="w-full bg-transparent text-sm text-slate-100 outline-none placeholder:text-muted/70"
                  />
                  {accent && (
                    <button type="button" onClick={() => setAccent('')} className="text-[10px] text-muted underline">
                      auto
                    </button>
                  )}
                </div>
              </div>

              <textarea
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                disabled={running}
                rows={2}
                placeholder={'Contact lines (one per line)\n+91 98765 43210 · hello@agency.com'}
                className="w-full resize-none rounded-lg border border-edge bg-ink px-2.5 py-1.5 text-sm text-slate-100 outline-none placeholder:text-muted/70 focus:border-accent"
              />
              <input
                value={socials}
                onChange={(e) => setSocials(e.target.value)}
                disabled={running}
                placeholder="Socials (slugs): instagram, whatsapp, facebook"
                className="w-full rounded-lg border border-edge bg-ink px-2.5 py-1.5 text-sm text-slate-100 outline-none placeholder:text-muted/70 focus:border-accent"
              />
            </div>
          )}
        </div>
      )}

      <button
        onClick={() =>
          goal.trim() && onSubmit(goal.trim(), active?.styles?.length ? styleKey : undefined, buildBrand())
        }
        disabled={running || !goal.trim()}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-accent to-accent2 py-2.5 text-sm font-semibold text-ink transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {running ? (
          <>
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink/40 border-t-ink" />
            Orchestrating…
          </>
        ) : (
          'Assign to CEO'
        )}
      </button>

      {placerOpen && logoUrl && (
        <LogoPlacer
          logoUrl={logoUrl}
          family={family}
          templateName={templateName}
          accent={mockAccent}
          brandName={brandName.trim() || undefined}
          value={placement}
          onSave={(v) => {
            setPlacement(v);
            setPlacerOpen(false);
          }}
          onClose={() => setPlacerOpen(false)}
        />
      )}
    </div>
  );
}
