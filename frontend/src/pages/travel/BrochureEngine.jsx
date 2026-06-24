// Travel CRM — Brochure Engine page.
//
// Wraps the agentic-orchcrm brochure engine (vendored under <repo>/agentic-orchcrm)
// as a first-class sidebar feature. Operators submit a brief, optionally upload
// a brand kit, and watch the live agent trace as the orchestrator delegates to
// specialists and renders an A4 PDF. Generated PDFs persist as TravelBrochure
// rows for re-download / history.
//
// Backend contract (backend/routes/travel_brochures.js):
//   POST   /api/travel/brochures/runs           { goal, sectorKey, styleKey?, brand?, tripId?, itineraryId? } → { runId, brochureId, status }
//   GET    /api/travel/brochures/runs/:runId    poll snapshot
//   GET    /api/travel/brochures/runs/:runId/stream  SSE live trace
//   GET    /api/travel/brochures/sectors        list available sectors + style keys
//   GET    /api/travel/brochures                tenant history (newest first, ≤100)
//   GET    /api/travel/brochures/:id            fetch one row
//   DELETE /api/travel/brochures/:id            soft-archive
//
// Style vocabulary mirrors ItineraryTemplates.jsx — CSS-var driven, inline styles,
// no Tailwind. Primary CTA uses var(--primary-color, var(--accent-color)) so the
// wellness theme override + generic theme both render correctly (per
// CLAUDE.md "Primary CTAs use var(--primary-color, …)" standing rule).
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Sparkles,
  FileText,
  Loader,
  History as HistoryIcon,
  Wand2,
  Image as ImageIcon,
  Trash2,
  Download,
  ExternalLink,
  AlertTriangle,
  CheckCircle2,
  X,
} from 'lucide-react';
import { fetchApi, getAuthToken } from '../../utils/api';
import { useNotify } from '../../utils/notify';

const DEFAULT_SECTOR = 'travel';

// Rewrite legacy `/brochure-assets/...` URLs (stored on older brochure
// rows) to the proxy-friendly `/api/brochure-assets/...` form. The
// backend mounts the static dir at both paths but Vite's dev proxy only
// forwards /api/*, so the bare /brochure-assets URL falls through to
// React Router and renders the SPA 404 page. New rows are written with
// the /api/ prefix by services/brochureEngineBridge.js after the
// 2026-06-24 fix.
function normalizeBrochureUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (url.startsWith('/brochure-assets/')) {
    return '/api' + url;
  }
  return url;
}
const SAMPLE_BRIEFS = [
  '7-day Paris + Rome family holiday for 2 adults + 2 kids in October. Mid-luxury hotels, must include Vatican, Eiffel, Louvre, Colosseum. End cover price ₹4.5L per adult, ₹3.2L per child.',
  '5-day Goa beach getaway for a young couple in December. 4-star beachfront resort, day trip to Dudhsagar Falls, sunset dolphin cruise. Budget ₹85K per person.',
  '12-day Umrah package for a family of 5 in Ramadan. Premium Makkah hotel within 200m of Haram, Madinah Hilton, ground + air transfers. Include religious-guide service. Cover price ₹2.85L per pilgrim.',
];

export default function BrochureEngine() {
  const notify = useNotify();
  const [sectors, setSectors] = useState([]);
  const [sectorKey, setSectorKey] = useState(DEFAULT_SECTOR);
  const [styleKey, setStyleKey] = useState('');
  const [goal, setGoal] = useState('');
  const [brandOpen, setBrandOpen] = useState(false);
  const [brand, setBrand] = useState({ name: '', tagline: '', logoUrl: '', accent: '#122647' });
  const [running, setRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState(null);
  const [activeBrochureId, setActiveBrochureId] = useState(null);
  const [traceEvents, setTraceEvents] = useState([]);
  const [result, setResult] = useState(null); // { pdfUrl, billedUsd, result }
  const [runError, setRunError] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [tab, setTab] = useState('generate'); // 'generate' | 'history'
  const esRef = useRef(null);
  const fileInputRef = useRef(null);
  // Tracks the most recent brochureId across stream-callback closures.
  // SSE handlers are created once per openStream(); without a ref the
  // closure would see whatever activeBrochureId was at subscribe time
  // (often null since the POST response set the state after subscribe).
  const activeBrochureIdRef = useRef(null);

  // ─── Initial load: sector catalog + history ────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const data = await fetchApi('/api/travel/brochures/sectors');
        if (data && Array.isArray(data.sectors)) setSectors(data.sectors);
      } catch (e) {
        // Non-fatal — fall back to a single-sector default so the form still works.
        console.warn('[brochures] sector list failed', e);
        setSectors([{ key: 'travel', name: 'Travel Brochure', styles: ['tmc-press', 'editorial-sakura'] }]);
      }
    })();
    loadHistory();
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const data = await fetchApi('/api/travel/brochures');
      if (data && Array.isArray(data.brochures)) setHistory(data.brochures);
    } catch (e) {
      console.warn('[brochures] history load failed', e);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const currentSector = sectors.find((s) => s.key === sectorKey) || sectors[0];
  const styleOptions = (currentSector && Array.isArray(currentSector.styles)) ? currentSector.styles : [];

  // ─── Brand-kit logo upload (→ data URI; server-side re-sanitized) ──────
  const onLogoFile = useCallback((file) => {
    if (!file) return;
    if (file.size > 200 * 1024) {
      notify.error('Logo too large — max 200KB.');
      return;
    }
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
      notify.error('Logo must be PNG, JPEG, WebP, or GIF.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setBrand((b) => ({ ...b, logoUrl: String(reader.result) }));
    };
    reader.readAsDataURL(file);
  }, [notify]);

  // ─── Start a run ───────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (e) => {
    e?.preventDefault?.();
    if (running) return;
    const trimmed = goal.trim();
    if (!trimmed) {
      notify.error('Please describe the brochure you want to generate.');
      return;
    }
    setRunning(true);
    setRunError(null);
    setResult(null);
    setTraceEvents([]);

    // Build the brand kit payload — drop empties so the server's sanitizer
    // doesn't have to bin them. The backend route re-validates everything.
    const brandPayload = {};
    if (brand.name?.trim()) brandPayload.name = brand.name.trim();
    if (brand.tagline?.trim()) brandPayload.tagline = brand.tagline.trim();
    if (brand.logoUrl) brandPayload.logoUrl = brand.logoUrl;
    if (/^#[0-9a-f]{6}$/i.test(brand.accent || '')) {
      brandPayload.colors = { accent: brand.accent };
    }

    try {
      const body = {
        goal: trimmed,
        sectorKey,
        ...(styleKey ? { styleKey } : {}),
        ...(Object.keys(brandPayload).length ? { brand: brandPayload } : {}),
      };
      const res = await fetchApi('/api/travel/brochures/runs', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const newRunId = res?.runId;
      const newBrochureId = res?.brochureId;
      if (!newRunId) throw new Error('No runId returned by the server.');
      setActiveRunId(newRunId);
      setActiveBrochureId(newBrochureId);
      activeBrochureIdRef.current = newBrochureId || null;
      openStream(newRunId);
      // Refresh history so the new row shows up immediately (in `running` state).
      loadHistory();
    } catch (err) {
      setRunning(false);
      setRunError(err?.message || String(err));
      notify.error('Failed to start brochure run.');
    }
  }, [running, goal, sectorKey, styleKey, brand, notify, loadHistory]);

  // Backfill the pdfUrl by reading the persisted brochure row. The
  // run.completed SSE event does NOT always carry pdfUrl (the trace
  // shows `pdf=-` even when the PDF rendered successfully); the row
  // returned by GET /api/travel/brochures/:id is the canonical source.
  // Auto-retries once with a short delay so the URL appears even when
  // the row write lags slightly behind the SSE emit.
  const backfillPdfUrl = useCallback(async (brochureId, attempt = 0) => {
    if (!brochureId) return;
    try {
      const detail = await fetchApi(`/api/travel/brochures/${brochureId}`);
      const url = normalizeBrochureUrl(detail?.pdfUrl || detail?.brochure?.pdfUrl || null);
      if (url) {
        setResult((prev) => ({ ...(prev || { billedUsd: 0, result: null }), pdfUrl: url }));
        return;
      }
      if (attempt < 3) {
        setTimeout(() => backfillPdfUrl(brochureId, attempt + 1), 1500);
      }
    } catch (e) {
      console.warn('[brochures] backfill pdfUrl failed', e);
    }
  }, []);

  // ─── SSE stream subscriber ─────────────────────────────────────────────
  const openStream = useCallback((runId) => {
    // Close any previous stream first.
    if (esRef.current) {
      try { esRef.current.close(); } catch { /* ignore */ }
      esRef.current = null;
    }
    const token = getAuthToken();
    // EventSource doesn't allow custom Authorization headers; the backend
    // SSE route still requires verifyToken. We use a fallback: pass the
    // JWT as a query-param ONLY if the standard header-auth EventSource
    // fails. For now, use a polyfill-free approach: append ?token= and let
    // the verifyToken middleware accept either header or query. (If the
    // CRM's verifyToken doesn't support query-token, the user still has
    // the polling fallback via GET /runs/:id below.)
    const url = `/api/travel/brochures/runs/${encodeURIComponent(runId)}/stream${
      token ? `?token=${encodeURIComponent(token)}` : ''
    }`;
    try {
      const es = new EventSource(url);
      esRef.current = es;
      es.onmessage = (ev) => {
        try {
          const event = JSON.parse(ev.data);
          setTraceEvents((prev) => [...prev, event]);
          if (event.type === 'run.completed') {
            const sseUrl = normalizeBrochureUrl(event.data?.pdfUrl || null);
            setResult({
              pdfUrl: sseUrl,
              billedUsd: event.data?.billedUsd || 0,
              result: event.data?.result || null,
            });
            setRunning(false);
            try { es.close(); } catch { /* ignore */ }
            esRef.current = null;
            loadHistory();
            // SSE event sometimes omits pdfUrl (visible in the trace as
            // `pdf=-`) even when the PDF rendered. Backfill from the
            // brochure row so the download button always appears.
            if (!sseUrl && activeBrochureIdRef.current) {
              backfillPdfUrl(activeBrochureIdRef.current);
            }
          } else if (event.type === 'run.failed') {
            setRunError(event.data?.error || 'Run failed');
            setRunning(false);
            try { es.close(); } catch { /* ignore */ }
            esRef.current = null;
            loadHistory();
          }
        } catch (parseErr) {
          console.warn('[brochures] bad SSE event', parseErr);
        }
      };
      es.onerror = () => {
        // EventSource auto-reconnects on transient errors. If we're already
        // settled, just close.
        if (!running) {
          try { es.close(); } catch { /* ignore */ }
          esRef.current = null;
          // Fall back to a one-shot polling fetch to get the final state.
          pollOnce(runId);
        }
      };
    } catch (e) {
      console.warn('[brochures] SSE failed, falling back to polling', e);
      pollOnce(runId);
    }
    // pollOnce is referenced via closure (declared below); intentionally
    // omitted from deps to avoid a TDZ on the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, loadHistory, backfillPdfUrl]);

  // Polling fallback when SSE isn't available.
  const pollOnce = useCallback(async (runId) => {
    try {
      const snap = await fetchApi(`/api/travel/brochures/runs/${encodeURIComponent(runId)}`);
      if (snap.status === 'completed') {
        setResult({ pdfUrl: normalizeBrochureUrl(snap.pdfUrl) || null, billedUsd: snap.billedUsd, result: null });
        setRunning(false);
        loadHistory();
        if (!snap.pdfUrl && activeBrochureIdRef.current) {
          backfillPdfUrl(activeBrochureIdRef.current);
        }
      } else if (snap.status === 'failed') {
        setRunError(snap.errorMessage || 'Run failed');
        setRunning(false);
        loadHistory();
      } else {
        // Still running — retry in 3s.
        setTimeout(() => pollOnce(runId), 3000);
      }
    } catch (e) {
      console.warn('[brochures] poll failed', e);
    }
  }, [loadHistory, backfillPdfUrl]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (esRef.current) {
        try { esRef.current.close(); } catch { /* ignore */ }
        esRef.current = null;
      }
    };
  }, []);

  const handleArchive = useCallback(async (row) => {
    if (!window.confirm(`Archive this brochure?\n\n${row.goal.slice(0, 120)}…`)) return;
    try {
      await fetchApi(`/api/travel/brochures/${row.id}`, { method: 'DELETE' });
      notify.success('Brochure archived.');
      loadHistory();
    } catch (e) {
      notify.error('Failed to archive brochure.');
    }
  }, [notify, loadHistory]);

  const handleSampleBrief = useCallback((text) => {
    setGoal(text);
  }, []);

  // ─── Render ────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={pageHeaderRow}>
        <div>
          <h1 style={pageTitle}>
            <Sparkles size={28} aria-hidden /> Brochure Engine
          </h1>
          <p style={pageSubtitle}>
            AI-powered, agency-grade travel brochures. One brief in, a multi-page A4 PDF out —
            cover, day-by-day itinerary, route map, inclusions, pricing. Powered by the
            agentic orchestration engine vendored under <code style={inlineCode}>agentic-orchcrm/</code>.
          </p>
        </div>
        <div style={tabBar}>
          <button
            type="button"
            onClick={() => setTab('generate')}
            style={tab === 'generate' ? activeTabBtn : tabBtn}
            data-testid="tab-generate"
          >
            <Wand2 size={14} /> Generate
          </button>
          <button
            type="button"
            onClick={() => setTab('history')}
            style={tab === 'history' ? activeTabBtn : tabBtn}
            data-testid="tab-history"
          >
            <HistoryIcon size={14} /> History {history.length > 0 ? `(${history.length})` : ''}
          </button>
        </div>
      </div>

      {tab === 'generate' && (
        <div style={twoColLayout}>
          {/* ─── Left: Form panel ──────────────────────────────────────── */}
          <form onSubmit={handleSubmit} style={panel}>
            <h2 style={panelTitle}>
              <FileText size={18} aria-hidden /> Brief
            </h2>

            <label style={fieldLabel}>
              Sector
              <select
                value={sectorKey}
                onChange={(e) => { setSectorKey(e.target.value); setStyleKey(''); }}
                style={selectStyle}
                disabled={running}
              >
                {sectors.map((s) => (
                  <option key={s.key} value={s.key}>{s.name || s.key}</option>
                ))}
              </select>
            </label>
            {currentSector?.description && (
              <p style={fieldHint}>{currentSector.description}</p>
            )}

            {styleOptions.length > 0 && (
              <label style={fieldLabel}>
                Template / Style
                <select
                  value={styleKey}
                  onChange={(e) => setStyleKey(e.target.value)}
                  style={selectStyle}
                  disabled={running}
                >
                  <option value="">Default ({styleOptions[0]})</option>
                  {styleOptions.map((k) => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
              </label>
            )}

            <label style={fieldLabel}>
              Brief
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                rows={8}
                maxLength={8000}
                placeholder="Describe the brochure you want. Destination, duration, traveller mix, hotel tier, must-visit sights, budget per person."
                style={{ ...inputStyle, minHeight: 160, fontFamily: 'inherit', resize: 'vertical' }}
                disabled={running}
                data-testid="brochure-goal"
              />
              <span style={fieldHintRight}>{goal.length} / 8000</span>
            </label>

            <div style={sampleRow}>
              <span style={{ ...fieldHint, marginRight: 6 }}>Try a sample:</span>
              {SAMPLE_BRIEFS.map((sample, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => handleSampleBrief(sample)}
                  style={chipBtn}
                  disabled={running}
                >
                  Sample {i + 1}
                </button>
              ))}
            </div>

            {/* Brand kit (collapsible) */}
            <div style={collapsible}>
              <button
                type="button"
                onClick={() => setBrandOpen((v) => !v)}
                style={collapsibleHeader}
              >
                <ImageIcon size={16} />
                Brand Kit {brand.logoUrl || brand.name ? '(set)' : '(optional)'}
                <span style={{ marginLeft: 'auto', fontSize: 18 }}>{brandOpen ? '−' : '+'}</span>
              </button>
              {brandOpen && (
                <div style={collapsibleBody}>
                  <label style={fieldLabel}>
                    Agency name
                    <input
                      type="text"
                      value={brand.name}
                      onChange={(e) => setBrand((b) => ({ ...b, name: e.target.value }))}
                      placeholder="Globus Travels"
                      style={inputStyle}
                      disabled={running}
                    />
                  </label>
                  <label style={fieldLabel}>
                    Tagline
                    <input
                      type="text"
                      value={brand.tagline}
                      onChange={(e) => setBrand((b) => ({ ...b, tagline: e.target.value }))}
                      placeholder="Crafted journeys, since 1998"
                      style={inputStyle}
                      disabled={running}
                    />
                  </label>
                  <label style={fieldLabel}>
                    Accent colour
                    <input
                      type="color"
                      value={brand.accent}
                      onChange={(e) => setBrand((b) => ({ ...b, accent: e.target.value }))}
                      style={{ ...inputStyle, padding: 2, height: 36, width: 60 }}
                      disabled={running}
                    />
                  </label>
                  <label style={fieldLabel}>
                    Logo (PNG / JPEG / WebP / GIF · ≤200KB)
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        onChange={(e) => onLogoFile(e.target.files?.[0])}
                        style={{ flex: 1 }}
                        disabled={running}
                      />
                      {brand.logoUrl && (
                        <button
                          type="button"
                          onClick={() => { setBrand((b) => ({ ...b, logoUrl: '' })); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                          style={iconBtn}
                          aria-label="Remove logo"
                          disabled={running}
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  </label>
                  {brand.logoUrl && (
                    <div style={logoPreview}>
                      <img src={brand.logoUrl} alt="Logo preview" style={{ maxHeight: 80, maxWidth: '100%' }} />
                    </div>
                  )}
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={running || !goal.trim()}
              style={running ? disabledPrimaryBtn : primaryBtn}
              data-testid="generate-brochure"
            >
              {running ? <><Loader size={16} className="anim-spin" /> Generating…</> : <><Sparkles size={16} /> Generate brochure</>}
            </button>
          </form>

          {/* ─── Right: Trace + Result panel ──────────────────────────── */}
          <div style={panel}>
            <h2 style={panelTitle}>
              <Loader size={18} aria-hidden /> Live trace
            </h2>
            {!activeRunId && (
              <div style={emptyStyle}>
                Submit a brief to watch the CEO agent plan, delegate to specialists, and render the PDF.
              </div>
            )}
            {activeRunId && (
              <>
                <div style={runIdRow}>
                  <span style={{ ...fieldHint, marginRight: 6 }}>Run id:</span>
                  <code style={inlineCode}>{activeRunId}</code>
                </div>
                <div style={traceBox} data-testid="trace-log">
                  {traceEvents.length === 0 && (
                    <div style={traceLineMuted}>Engine starting up — first events arrive in a moment…</div>
                  )}
                  {traceEvents.map((e, i) => (
                    <TraceLine key={i} event={e} />
                  ))}
                </div>
                {runError && (
                  <div style={errorBox} data-testid="brochure-error">
                    <AlertTriangle size={16} /> {runError}
                  </div>
                )}
                {result && (
                  <div style={resultBox} data-testid="brochure-result">
                    <div style={resultHeader}>
                      <CheckCircle2 size={18} color="var(--primary-color, var(--accent-color))" />
                      <span style={{ fontWeight: 600 }}>Brochure ready</span>
                      {result.billedUsd != null && (
                        <span style={costBadge}>${Number(result.billedUsd).toFixed(4)}</span>
                      )}
                      {result.pdfUrl ? (
                        <>
                          <a
                            href={result.pdfUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ ...secondaryBtn, marginLeft: 'auto', textDecoration: 'none' }}
                            data-testid="brochure-open"
                          >
                            <ExternalLink size={14} /> Open
                          </a>
                          <a
                            href={result.pdfUrl}
                            download
                            style={{ ...secondaryBtn, textDecoration: 'none' }}
                            data-testid="brochure-download"
                          >
                            <Download size={14} /> Download
                          </a>
                        </>
                      ) : (
                        // SSE event didn't include pdfUrl yet — show a
                        // retry button so the user always has a way to
                        // grab the PDF once it lands. backfillPdfUrl is
                        // also auto-firing on a short delay loop above.
                        <button
                          type="button"
                          onClick={() => activeBrochureIdRef.current && backfillPdfUrl(activeBrochureIdRef.current)}
                          style={{ ...secondaryBtn, marginLeft: 'auto' }}
                          data-testid="brochure-download-retry"
                        >
                          <Download size={14} /> Fetch PDF
                        </button>
                      )}
                    </div>
                    {result.pdfUrl ? (
                      <iframe
                        src={result.pdfUrl}
                        title="Brochure preview"
                        style={pdfFrame}
                      />
                    ) : (
                      <div style={{ ...emptyStyle, padding: 16 }}>
                        Locating the rendered PDF… click <strong>Fetch PDF</strong> if it doesn&apos;t appear in a moment.
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'history' && (
        <div style={panel}>
          <h2 style={panelTitle}>
            <HistoryIcon size={18} aria-hidden /> Brochure history
          </h2>
          {historyLoading && <div style={emptyStyle}>Loading…</div>}
          {!historyLoading && history.length === 0 && (
            <div style={emptyStyle}>No brochures generated yet. Switch to <strong>Generate</strong> to make your first one.</div>
          )}
          {!historyLoading && history.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={th}>Created</th>
                    <th style={th}>Brief</th>
                    <th style={th}>Sector / Style</th>
                    <th style={th}>Status</th>
                    <th style={th}>Cost</th>
                    <th style={th} aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {history.map((row) => (
                    <tr key={row.id}>
                      <td style={td}>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                          {new Date(row.createdAt).toLocaleString()}
                        </div>
                      </td>
                      <td style={{ ...td, maxWidth: 360 }}>
                        <div style={ellipsis2}>{row.goal}</div>
                      </td>
                      <td style={td}>
                        <span style={brandBadge}>{row.sectorKey}</span>
                        {row.styleKey && <span style={{ ...brandBadge, marginLeft: 4 }}>{row.styleKey}</span>}
                      </td>
                      <td style={td}>
                        <StatusBadge status={row.status} />
                        {row.errorMessage && (
                          <div style={{ fontSize: 11, color: '#b00', marginTop: 4 }} title={row.errorMessage}>
                            {row.errorMessage.slice(0, 80)}
                          </div>
                        )}
                      </td>
                      <td style={td}>
                        {row.billedUsd != null ? `$${Number(row.billedUsd).toFixed(4)}` : '—'}
                      </td>
                      <td style={td}>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {row.pdfUrl && (
                            <a
                              href={normalizeBrochureUrl(row.pdfUrl)}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={iconBtn}
                              title="Open PDF"
                            >
                              <ExternalLink size={14} />
                            </a>
                          )}
                          {row.pdfUrl && (
                            <a
                              href={normalizeBrochureUrl(row.pdfUrl)}
                              download
                              style={iconBtn}
                              title="Download"
                            >
                              <Download size={14} />
                            </a>
                          )}
                          <button
                            type="button"
                            onClick={() => handleArchive(row)}
                            style={iconBtn}
                            title="Archive"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

function TraceLine({ event }) {
  if (!event) return null;
  const type = String(event.type || 'unknown');
  const agentKey = event.agentKey || event.parentAgentKey || '';
  const dataPreview = (() => {
    const d = event.data || {};
    if (typeof d === 'string') return d.slice(0, 200);
    if (type === 'agent.tool_call') return `→ ${String(d.tool || '')}`;
    if (type === 'delegation.started') return `→ delegate "${String(d.task || '').slice(0, 80)}"`;
    if (type === 'usage') return `${d.model || ''} · in ${d.inputTokens ?? '?'} / out ${d.outputTokens ?? '?'} · $${Number(d.billedUsd || 0).toFixed(4)}`;
    if (type === 'run.completed') return `✓ done · pdf=${d.pdfUrl || '—'} · $${Number(d.billedUsd || 0).toFixed(4)}`;
    if (type === 'run.failed') return `✖ ${String(d.error || '')}`;
    if (type === 'agent.message' && d.final) return '✓ produced final result';
    return '';
  })();
  return (
    <div style={traceLine}>
      <span style={traceType}>{type}</span>
      {agentKey && <span style={traceAgent}>{agentKey}</span>}
      {dataPreview && <span style={traceData}>{dataPreview}</span>}
    </div>
  );
}

function StatusBadge({ status }) {
  let bg = 'var(--subtle-bg-3)';
  let fg = 'var(--text-secondary)';
  if (status === 'completed') { bg = 'rgba(34,134,58,0.15)'; fg = '#22863a'; }
  else if (status === 'failed') { bg = 'rgba(176,0,0,0.15)'; fg = '#b00'; }
  else if (status === 'running') { bg = 'rgba(38,88,85,0.15)'; fg = 'var(--primary-color, var(--accent-color))'; }
  return (
    <span style={{
      padding: '2px 8px',
      borderRadius: 4,
      fontSize: 11,
      fontWeight: 600,
      background: bg,
      color: fg,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    }}>{status}</span>
  );
}

// ─── Styles (CSS-var-driven, matches ItineraryTemplates.jsx) ──────────────
const pageHeaderRow = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  flexWrap: 'wrap',
  gap: 12,
  marginBottom: 16,
};
const pageTitle = { display: 'flex', alignItems: 'center', gap: 10, margin: 0 };
const pageSubtitle = { color: 'var(--text-secondary)', marginTop: 4, maxWidth: 720 };
const tabBar = { display: 'flex', gap: 4, background: 'var(--subtle-bg)', borderRadius: 8, padding: 4 };
const tabBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 14px',
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: 'transparent',
  color: 'var(--text-secondary)',
  border: 'none',
  cursor: 'pointer',
};
const activeTabBtn = {
  ...tabBtn,
  background: 'var(--surface-color)',
  color: 'var(--primary-color, var(--accent-color))',
  boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
};
const twoColLayout = {
  display: 'grid',
  gap: 16,
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 480px), 1fr))',
  alignItems: 'flex-start',
};
const panel = {
  background: 'var(--surface-color)',
  padding: 16,
  borderRadius: 8,
  border: '1px solid var(--border-color)',
};
const panelTitle = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 16, margin: '0 0 12px 0' };
const fieldLabel = { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12, fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 };
const fieldHint = { fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 };
const fieldHintRight = { fontSize: 11, color: 'var(--text-secondary)', textAlign: 'right' };
const inputStyle = {
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--border-color)',
  background: 'var(--bg-color)',
  color: 'var(--text-primary)',
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
};
const selectStyle = { ...inputStyle, background: 'var(--surface-color)' };
const inlineCode = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  padding: '1px 5px',
  borderRadius: 3,
  background: 'var(--subtle-bg)',
  color: 'var(--text-primary)',
};
const sampleRow = { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', marginTop: -4, marginBottom: 12 };
const chipBtn = {
  fontSize: 11,
  padding: '3px 8px',
  borderRadius: 12,
  border: '1px solid var(--border-color)',
  background: 'var(--bg-color)',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
};
const collapsible = { border: '1px solid var(--border-color)', borderRadius: 6, marginBottom: 12 };
const collapsibleHeader = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '10px 12px',
  border: 'none',
  background: 'var(--subtle-bg)',
  color: 'var(--text-primary)',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  borderRadius: 6,
};
const collapsibleBody = { padding: 12 };
const logoPreview = {
  padding: 12,
  background: 'var(--subtle-bg)',
  borderRadius: 6,
  textAlign: 'center',
};
const primaryBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '10px 16px',
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 14,
  background: 'var(--primary-color, var(--accent-color))',
  color: '#fff',
  border: 'none',
  cursor: 'pointer',
  width: '100%',
  justifyContent: 'center',
};
const disabledPrimaryBtn = { ...primaryBtn, opacity: 0.6, cursor: 'not-allowed' };
const secondaryBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 12px',
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 12,
  background: 'var(--surface-color)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-color)',
  cursor: 'pointer',
};
const iconBtn = {
  padding: 4,
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--text-secondary)',
  border: 'none',
  cursor: 'pointer',
};
const emptyStyle = {
  padding: 32,
  textAlign: 'center',
  color: 'var(--text-secondary)',
  fontSize: 13,
};
const runIdRow = { display: 'flex', alignItems: 'center', marginBottom: 8 };
const traceBox = {
  background: 'var(--bg-color)',
  border: '1px solid var(--border-color)',
  borderRadius: 6,
  padding: 8,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  maxHeight: 320,
  overflowY: 'auto',
};
const traceLine = { display: 'flex', gap: 6, padding: '2px 4px', borderBottom: '1px dashed var(--border-color)', alignItems: 'baseline' };
const traceLineMuted = { ...traceLine, color: 'var(--text-secondary)', justifyContent: 'center', borderBottom: 'none' };
const traceType = { color: 'var(--primary-color, var(--accent-color))', minWidth: 130, fontWeight: 600 };
const traceAgent = { color: 'var(--text-primary)', minWidth: 80 };
const traceData = { color: 'var(--text-secondary)', wordBreak: 'break-word', flex: 1 };
const errorBox = {
  marginTop: 8,
  padding: 10,
  borderRadius: 6,
  background: 'rgba(176,0,0,0.08)',
  border: '1px solid rgba(176,0,0,0.25)',
  color: '#b00',
  fontSize: 13,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};
const resultBox = { marginTop: 12, padding: 10, borderRadius: 6, background: 'var(--subtle-bg)', border: '1px solid var(--border-color)' };
const resultHeader = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' };
const costBadge = {
  padding: '2px 8px',
  borderRadius: 12,
  background: 'var(--subtle-bg-3)',
  color: 'var(--text-primary)',
  fontSize: 11,
  fontWeight: 600,
};
const pdfFrame = {
  width: '100%',
  height: 480,
  border: '1px solid var(--border-color)',
  borderRadius: 6,
  background: 'white',
};
const tableStyle = { width: '100%', borderCollapse: 'collapse' };
const th = {
  textAlign: 'left',
  padding: '10px 12px',
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: 'var(--text-secondary)',
  borderBottom: '1px solid var(--border-color)',
  background: 'var(--subtle-bg)',
};
const td = { padding: '10px 12px', fontSize: 14, color: 'var(--text-primary)', verticalAlign: 'top', borderBottom: '1px solid var(--border-color)' };
const brandBadge = {
  padding: '2px 8px',
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 600,
  background: 'var(--subtle-bg-3)',
  color: 'var(--primary-color, var(--accent-color))',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};
const ellipsis2 = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
