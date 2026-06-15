/**
 * MarketingFlyerStudio.jsx — dedicated Marketing Flyer editor (GH #908;
 * PRD docs/PRD_TRAVEL_MARKETING_FLYER.md). Client decision: build an in-house
 * dedicated editor (not the landing-page-builder reuse, not Polotno).
 *
 * Slice 1 (this file): a canvas editor that mutates the `layout` array —
 *   - Add Text / Add Image blocks (absolute x/y/width/height in CANVAS space).
 *   - Click to select; drag to move; numeric X/Y/W/H inputs for precision.
 *   - Edit text content / colour / font-size; edit image URL; delete block.
 *   - Edit the 5 palette colours via toolbar swatches (canvas bg = bgHex).
 * The editor mutates the SAME palette/layout/assets state the existing
 * load + Save-as-Template lifecycle serialises (slice 5, /api/travel/
 * flyer-templates), so that flow is unchanged.
 *
 * Follow-up slices: image upload (Multer), resize handles + more block types,
 * PNG/PDF export, brand-lock to the sub-brand kit, WhatsApp/email share.
 *
 * Mount: /travel/marketing/flyer-studio — <TravelOnly> + <RoleGuard
 * allow={['ADMIN','MANAGER']}/> per the PRD NFR-4.8 RBAC surface.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FileImage, Save, Loader, Sparkles, Image as ImageIcon, Undo2, Redo2, Grid3x3 } from 'lucide-react';
import { useActiveSubBrand } from '../../utils/subBrand';
import { useNotify } from '../../utils/notify';
import { fetchApi, getAuthToken } from '../../utils/api';

// Translate the verbose raw AI-provider error (Google / OpenAI dump 500+
// chars of JSON + stack into the message) into a short, plain-English
// sentence operators can act on. Falls through to a generic message if
// no pattern matches. Keep order specific → generic.
function friendlyAiError(rawError) {
  if (!rawError) return 'AI service is temporarily unavailable. Please try again.';
  const m = String(rawError).toLowerCase();
  if (/429|too many requests|exceeded.*quota|quota exceeded|rate limit/.test(m)) {
    return "AI service is currently busy — daily limit reached on multiple models. Please try again later or upgrade the API plan.";
  }
  if (/401|unauthorized|invalid.*api.*key|api key.*invalid|incorrect.*key/.test(m)) {
    return 'AI service rejected the API key. Please check the key configuration in the backend .env file.';
  }
  if (/403|forbidden|permission/.test(m)) {
    return "AI service blocked the request. Your API key may not have access to this model.";
  }
  if (/404|does not exist|unknown model|model.*not.*found/.test(m)) {
    return 'AI model not available. Please contact support to update the model configuration.';
  }
  if (/timeout|abort|aborted/.test(m)) {
    return 'AI service timed out. Please try again in a moment.';
  }
  if (/safety|blocked|finishreason.*safety/.test(m)) {
    return 'AI service blocked the prompt for safety reasons. Try rephrasing the destination or theme.';
  }
  if (/json.*parse|parse.*failed|invalid.*response/.test(m)) {
    return "AI service returned a malformed response. Please try again.";
  }
  if (/network|fetch.*failed|enotfound|econnrefused/.test(m)) {
    return 'Cannot reach the AI service. Please check your internet connection.';
  }
  // Generic fallback — short, friendly, doesn't dump raw error to user.
  return 'AI service is temporarily unavailable. Please try again in a moment.';
}

// Sub-brand options for the "Save as Template" modal — the canonical 4 ids
// plus "no sub-brand" (tenant-wide template).
const SAVE_SUB_BRAND_OPTIONS = [
  { value: '', label: 'Tenant-wide (no sub-brand)' },
  { value: 'tmc', label: 'TMC (schools)' },
  { value: 'rfu', label: 'RFU (Umrah)' },
  { value: 'travelstall', label: 'Travel Stall' },
  { value: 'visasure', label: 'Visa Sure' },
];

// Default composer state — minimum-valid shape: 4+ hex colours + 1 text block.
const DEFAULT_PALETTE = {
  primaryHex: '#122647',
  secondaryHex: '#265855',
  accentHex: '#C89A4E',
  textHex: '#222222',
  bgHex: '#FFFDF7',
};
const DEFAULT_LAYOUT = [
  { type: 'text', x: 24, y: 24, width: 480, height: 80, content: 'Tap to edit headline' },
];
const DEFAULT_ASSETS = {};

// Slice-1 editor: the 5 palette colours editable via the toolbar swatches.
const PALETTE_KEYS = ['primaryHex', 'secondaryHex', 'accentHex', 'textHex', 'bgHex'];

// What each palette colour actually drives in the rendered/exported flyer
// (lib/flyerPdfRender.js + services/flyerRenderEngine.js). Most aren't
// visible on a near-empty canvas, so we surface a short label + a tooltip
// explaining the effect — otherwise only "Background" looks like it works.
const PALETTE_META = {
  primaryHex: { label: 'Primary', hint: 'CTA button text colour' },
  secondaryHex: { label: 'Secondary', hint: 'Price block text colour' },
  accentHex: { label: 'Accent', hint: 'Placeholder fill for empty image / logo blocks' },
  textHex: { label: 'Text', hint: 'Default colour for new text blocks' },
  bgHex: { label: 'Background', hint: 'Flyer / canvas background colour' },
};
// Editor canvas dimensions (portrait flyer). Blocks are positioned in this
// coordinate space; export-to-PNG/PDF lands in a later slice.
const CANVAS_W = 540;
const CANVAS_H = 720;

// Snap-to-grid step (canvas px) — drag/resize round to this when snap is on.
const GRID = 10;

// Block-type starting shapes. The render engine (lib/flyerPdfRender.js +
// services/flyerRenderEngine.js) supports text / price / cta / image / logo:
// price→secondaryHex, cta→primaryHex (colour applied at render); image+logo
// carry a `src`. Editor mirrors those so the canvas is WYSIWYG.
const BLOCK_DEFAULTS = {
  text: { type: 'text', width: 240, height: 48, content: 'New text', fontSize: 18 },
  price: { type: 'price', width: 200, height: 48, content: '₹ 49,999', fontSize: 24 },
  cta: { type: 'cta', width: 200, height: 50, content: 'Book Now', fontSize: 18 },
  image: { type: 'image', width: 180, height: 120, src: '' },
  logo: { type: 'logo', width: 140, height: 60, src: '' },
};
const SRC_TYPES = new Set(['image', 'logo']);
const TEXT_TYPES = new Set(['text', 'price', 'cta']);

// Font families offered for text/price/cta blocks. Limited to the three the
// PDF export can render natively (pdfkit standard-14: Helvetica / Times /
// Courier) so the editor canvas, PNG export, and PDF export all match.
const FONT_CSS = {
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', Times, serif",
  mono: "'Courier New', Courier, monospace",
};
const FONT_OPTIONS = [
  { value: 'sans', label: 'Sans-serif' },
  { value: 'serif', label: 'Serif' },
  { value: 'mono', label: 'Monospace' },
];
const ALIGN_OPTIONS = [
  { value: 'left', label: 'L', aria: 'Align left' },
  { value: 'center', label: 'C', aria: 'Align center' },
  { value: 'right', label: 'R', aria: 'Align right' },
];

export default function MarketingFlyerStudio() {
  const { activeSubBrand } = useActiveSubBrand() || { activeSubBrand: null };
  const notify = useNotify();
  const [searchParams, setSearchParams] = useSearchParams();

  // Composer state — palette / layout / assets.
  const [palette, setPalette] = useState(DEFAULT_PALETTE);
  const [layout, setLayout] = useState(DEFAULT_LAYOUT);
  const [assets, setAssets] = useState(DEFAULT_ASSETS);

  const [loadedTemplate, setLoadedTemplate] = useState(null);
  const [loading, setLoading] = useState(false);

  // "Save as Template" modal state.
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveSubBrand, setSaveSubBrand] = useState(activeSubBrand || '');
  const [saving, setSaving] = useState(false);

  // ── Slice-1 editor state + handlers ─────────────────────────────────
  const [selectedIdx, setSelectedIdx] = useState(null);
  const dragRef = useRef(null);
  const resizeRef = useRef(null);
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);

  // ── Undo/redo + snap-to-grid ────────────────────────────────────────
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [snapToGrid, setSnapToGrid] = useState(true);
  // Mirror the live state into a ref so commit() always snapshots the
  // CURRENT (pre-mutation) state without stale-closure bugs from the
  // various useCallback handlers that push history.
  const stateRef = useRef({ layout, palette, assets });
  useEffect(() => { stateRef.current = { layout, palette, assets }; }, [layout, palette, assets]);
  const pushHistory = useCallback((snap) => {
    setUndoStack((s) => [...s.slice(-49), snap]); // cap at 50 entries
    setRedoStack([]);
  }, []);
  // Call BEFORE a mutation to record the state to revert to.
  const commit = useCallback(() => { pushHistory(stateRef.current); }, [pushHistory]);
  const undo = useCallback(() => {
    if (!undoStack.length) return;
    const prev = undoStack[undoStack.length - 1];
    setRedoStack((r) => [...r, stateRef.current]);
    setUndoStack((s) => s.slice(0, -1));
    setLayout(Array.isArray(prev.layout) ? prev.layout : []);
    if (prev.palette) setPalette(prev.palette);
    if (prev.assets) setAssets(prev.assets);
    setSelectedIdx(null);
  }, [undoStack]);
  const redo = useCallback(() => {
    if (!redoStack.length) return;
    const next = redoStack[redoStack.length - 1];
    setUndoStack((s) => [...s, stateRef.current]);
    setRedoStack((r) => r.slice(0, -1));
    setLayout(Array.isArray(next.layout) ? next.layout : []);
    if (next.palette) setPalette(next.palette);
    if (next.assets) setAssets(next.assets);
    setSelectedIdx(null);
  }, [redoStack]);
  const snap = useCallback((v) => (snapToGrid ? Math.round(v / GRID) * GRID : Math.round(v)), [snapToGrid]);

  // Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl+Y = redo. Ignored while
  // typing in an input/textarea so it doesn't fight native text undo.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const k = (e.key || '').toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // S71 / S72 — AI copy + image generation modal state.
  const [showCopyModal, setShowCopyModal] = useState(false);
  const [showImageModal, setShowImageModal] = useState(false);
  const [aiDestination, setAiDestination] = useState('');
  const [aiAudience, setAiAudience] = useState('');
  const [aiAspectRatio, setAiAspectRatio] = useState('1:1');
  const [aiBusy, setAiBusy] = useState(false);

  const addBlock = useCallback((type) => {
    commit();
    setLayout((prev) => {
      const offset = prev.length * 12;
      const base = BLOCK_DEFAULTS[type] || BLOCK_DEFAULTS.text;
      const block = { ...base, x: 24, y: 24 + offset };
      // Only plain text carries an editable colour; price/cta colours are
      // applied by the render engine (secondary/primary) for brand consistency.
      if (type === 'text') block.color = palette.textHex || '#222222';
      return [...prev, block];
    });
  }, [palette, commit]);

  const updateBlock = useCallback((idx, patch) => {
    setLayout((prev) => prev.map((b, i) => (i === idx ? { ...b, ...patch } : b)));
  }, []);

  const removeBlock = useCallback((idx) => {
    commit();
    setLayout((prev) => prev.filter((_, i) => i !== idx));
    setSelectedIdx(null);
  }, [commit]);

  // Change a palette colour AND re-theme every block currently using the OLD
  // value, so the swatch visibly updates existing content (not just the
  // canvas bg). Without this, a block's baked-in `color` (set when it was
  // created) ignores later palette edits — which is why "only the last
  // swatch worked". Manual one-off colours that don't match a palette value
  // are left untouched. bgHex isn't a text colour, so it only sets the bg.
  const setPaletteKey = useCallback((k, newVal) => {
    const oldVal = palette[k] || '';
    setPalette((p) => ({ ...p, [k]: newVal }));
    if (k !== 'bgHex' && oldVal && oldVal.toLowerCase() !== String(newVal).toLowerCase()) {
      setLayout((prev) => prev.map((b) =>
        (b.color && String(b.color).toLowerCase() === oldVal.toLowerCase())
          ? { ...b, color: newVal }
          : b,
      ));
    }
  }, [palette]);

  // S71 — POST destination + audience to /suggest-copy. On success insert
  // three new text blocks (headline / body / cta) into the canvas. Smart
  // placement: if the canvas is "fresh" (only the default "Tap to edit
  // headline" placeholder) REPLACE it with the AI copy; otherwise append
  // the new blocks BELOW the bottom-most existing block with a 24px gap.
  // Prevents the overlapping-blocks-at-same-position bug that happens
  // when blocks are pinned to fixed y coordinates.
  const handleSuggestCopy = useCallback(async (e) => {
    e?.preventDefault?.();
    const dest = (aiDestination || '').trim();
    if (!dest) {
      notify?.error?.('Destination is required');
      return;
    }
    setAiBusy(true);
    try {
      const body = { destination: dest };
      if (aiAudience.trim()) body.targetAudience = aiAudience.trim();
      if (activeSubBrand) body.subBrand = activeSubBrand;
      const data = await fetchApi('/api/travel/flyer-templates/suggest-copy', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      // Real-mode tried + failed (e.g. Gemini 429 / 401 / parse error).
      // Show the actual reason instead of silently inserting [STUB]
      // marker text into the canvas.
      if (data.stub && data.realModeError) {
        notify?.error?.(friendlyAiError(data.realModeError));
        setShowCopyModal(false);
        return;
      }
      commit();
      setLayout((prev) => {
        const isFresh =
          prev.length === 1 &&
          prev[0].type === 'text' &&
          prev[0].content === 'Tap to edit headline';
        const startY = isFresh
          ? 24
          : Math.max(0, ...prev.map((b) => (b.y || 0) + (b.height || 0))) + 24;
        const newBlocks = [
          {
            type: 'text',
            x: 24,
            y: startY,
            width: 480,
            height: 100,
            content: data.headline || '',
            color: palette.primaryHex || '#122647',
            fontSize: 28,
          },
          {
            type: 'text',
            x: 24,
            y: startY + 116,
            width: 480,
            height: 140,
            content: data.body || '',
            color: palette.textHex || '#222222',
            fontSize: 16,
          },
          {
            type: 'text',
            x: 24,
            y: startY + 272,
            width: 220,
            height: 50,
            content: data.cta || '',
            color: palette.accentHex || '#C89A4E',
            fontSize: 18,
          },
        ];
        return isFresh ? newBlocks : [...prev, ...newBlocks];
      });
      // Select the headline so the operator can immediately edit / restyle it.
      setSelectedIdx(null);
      setShowCopyModal(false);
      notify?.success?.(
        data.stub
          ? 'AI copy inserted (stub — set GEMINI_API_KEY for real output)'
          : 'AI copy inserted',
      );
    } catch (err) {
      if (!err?.status) notify?.error?.(err?.message || 'Failed to generate copy');
    } finally {
      setAiBusy(false);
    }
  }, [aiDestination, aiAudience, activeSubBrand, palette, notify, commit]);

  // S72 — POST destination + aspectRatio to /suggest-image. On success
  // EITHER replace the selected image block's src OR add a new image block
  // pre-filled with the imageUrl. DALL-E URLs are time-limited (~1h) —
  // operator should Save-as-Template promptly to capture into assetsJson.
  const handleSuggestImage = useCallback(async (e) => {
    e?.preventDefault?.();
    const dest = (aiDestination || '').trim();
    if (!dest) {
      notify?.error?.('Destination is required');
      return;
    }
    setAiBusy(true);
    try {
      const body = { destination: dest, aspectRatio: aiAspectRatio };
      if (activeSubBrand) body.subBrand = activeSubBrand;
      const data = await fetchApi('/api/travel/flyer-templates/suggest-image', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      // Real-mode tried + failed (e.g. OpenAI 400/401/429 or unknown
      // model). Show the actual reason instead of silently inserting a
      // [STUB-FLYER-IMAGE] URL the browser can't render → empty box.
      if (data.stub && data.realModeError) {
        notify?.error?.(friendlyAiError(data.realModeError));
        setShowImageModal(false);
        return;
      }
      const url = data.imageUrl;
      // Smart placement, mirroring the copy flow:
      //   1. Selected block is image  → replace its src
      //   2. Canvas is fresh (default placeholder only) → REPLACE with image
      //   3. Otherwise → append below the bottom-most existing block
      const sel = selectedIdx != null ? layout[selectedIdx] : null;
      if (sel && sel.type === 'image') {
        updateBlock(selectedIdx, { src: url });
      } else {
        const dim = aiAspectRatio === '9:16'
          ? { width: 240, height: 426 }
          : aiAspectRatio === '16:9'
            ? { width: 480, height: 270 }
            : { width: 320, height: 320 };
        setLayout((prev) => {
          const isFresh =
            prev.length === 1 &&
            prev[0].type === 'text' &&
            prev[0].content === 'Tap to edit headline';
          const startY = isFresh
            ? 24
            : Math.max(0, ...prev.map((b) => (b.y || 0) + (b.height || 0))) + 24;
          const newBlock = { type: 'image', x: 24, y: startY, ...dim, src: url };
          return isFresh ? [newBlock] : [...prev, newBlock];
        });
      }
      setShowImageModal(false);
      notify?.success?.(
        data.stub
          ? 'AI image inserted (stub — set OPENAI_API_KEY for real output)'
          : 'AI image inserted — save the template soon (DALL-E URLs expire in ~1h)',
      );
    } catch (err) {
      if (!err?.status) notify?.error?.(err?.message || 'Failed to generate image');
    } finally {
      setAiBusy(false);
    }
  }, [aiDestination, aiAspectRatio, activeSubBrand, selectedIdx, layout, updateBlock, notify]);

  // Pointer-drag to reposition a block; numeric X/Y inputs are the precise fallback.
  const onBlockMouseDown = useCallback((e, idx) => {
    e.preventDefault();
    setSelectedIdx(idx);
    const b = layout[idx] || {};
    // Stash the pre-drag snapshot; only push to history on actual movement
    // (so a plain click-to-select doesn't spam empty undo entries).
    dragRef.current = { idx, startX: e.clientX, startY: e.clientY, origX: b.x || 0, origY: b.y || 0, snapshot: stateRef.current, moved: false };
  }, [layout]);
  const onResizeMouseDown = useCallback((e, idx) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedIdx(idx);
    const b = layout[idx] || {};
    resizeRef.current = { idx, startX: e.clientX, startY: e.clientY, origW: b.width || GRID, origH: b.height || GRID, snapshot: stateRef.current, moved: false };
  }, [layout]);
  const onCanvasMouseMove = useCallback((e) => {
    const r = resizeRef.current;
    if (r) {
      const nw = Math.max(GRID, snap(r.origW + (e.clientX - r.startX)));
      const nh = Math.max(GRID, snap(r.origH + (e.clientY - r.startY)));
      r.moved = true;
      setLayout((prev) => prev.map((b, i) => (i === r.idx ? { ...b, width: nw, height: nh } : b)));
      return;
    }
    const d = dragRef.current;
    if (!d) return;
    const nx = Math.max(0, snap(d.origX + (e.clientX - d.startX)));
    const ny = Math.max(0, snap(d.origY + (e.clientY - d.startY)));
    d.moved = true;
    setLayout((prev) => prev.map((b, i) => (i === d.idx ? { ...b, x: nx, y: ny } : b)));
  }, [snap]);
  const onCanvasMouseUp = useCallback(() => {
    if (dragRef.current && dragRef.current.moved) pushHistory(dragRef.current.snapshot);
    if (resizeRef.current && resizeRef.current.moved) pushHistory(resizeRef.current.snapshot);
    dragRef.current = null;
    resizeRef.current = null;
  }, [pushHistory]);

  // FR-3.2.2 — upload an image for the selected image block. Raw fetch + FormData
  // (fetchApi forces JSON content-type, so we bypass it — same as the landing-page
  // image upload). Server returns { url } (S3 when configured, else local).
  const handleUploadImage = useCallback(async (file, idx) => {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('image', file);
      const token = getAuthToken();
      const res = await fetch('/api/travel/flyer-templates/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        notify?.error?.(data?.error || 'Image upload failed');
        return;
      }
      commit();
      updateBlock(idx, { src: data.url });
    } catch (e) {
      notify?.error?.(e?.message || 'Image upload failed');
    } finally {
      setUploading(false);
    }
  }, [notify, updateBlock, commit]);

  // Parse @db.Text JSON columns — tolerates JSON string OR already-parsed object.
  const parseJsonField = useCallback((field, fallback) => {
    if (field == null) return fallback;
    if (typeof field === 'object') return field;
    if (typeof field === 'string') {
      try {
        return JSON.parse(field);
      } catch (_e) {
        return fallback;
      }
    }
    return fallback;
  }, []);

  const loadTemplate = useCallback(
    async (templateId) => {
      setLoading(true);
      try {
        const data = await fetchApi(`/api/travel/flyer-templates/${templateId}`);
        const parsedPalette = parseJsonField(data?.paletteJson, DEFAULT_PALETTE);
        const parsedLayout = parseJsonField(data?.layoutJson, DEFAULT_LAYOUT);
        const parsedAssets = parseJsonField(data?.assetsJson, DEFAULT_ASSETS);
        setPalette(parsedPalette || DEFAULT_PALETTE);
        setLayout(Array.isArray(parsedLayout) ? parsedLayout : DEFAULT_LAYOUT);
        setAssets(parsedAssets && typeof parsedAssets === 'object' ? parsedAssets : DEFAULT_ASSETS);
        setSelectedIdx(null);
        setLoadedTemplate({
          id: data?.id ?? templateId,
          name: data?.name || `Template #${templateId}`,
          subBrand: data?.subBrand || null,
        });
        setSaveName(data?.name ? `${data.name} (copy)` : '');
        setSaveSubBrand(data?.subBrand || activeSubBrand || '');
        notify?.info?.(`Loaded template: ${data?.name || `#${templateId}`}`);
      } catch (err) {
        setLoadedTemplate(null);
        if (!err?.status) {
          notify?.error?.(err?.message || 'Failed to load template');
        }
      } finally {
        setLoading(false);
      }
    },
    [activeSubBrand, notify, parseJsonField],
  );

  // Mount effect: ?template=<id> → load. Depend on the param VALUE only.
  const templateIdParam = searchParams?.get?.('template') || null;
  useEffect(() => {
    if (templateIdParam && /^\d+$/.test(templateIdParam)) {
      loadTemplate(parseInt(templateIdParam, 10));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateIdParam]);

  const openSaveModal = () => {
    setSaveName(loadedTemplate?.name ? `${loadedTemplate.name} (copy)` : '');
    setSaveSubBrand(loadedTemplate?.subBrand || activeSubBrand || '');
    setShowSaveModal(true);
  };

  const closeSaveModal = () => {
    setShowSaveModal(false);
  };

  const handleSaveTemplate = async (e) => {
    e?.preventDefault?.();
    const trimmedName = (saveName || '').trim();
    if (!trimmedName) {
      notify?.error?.('Template name is required');
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: trimmedName,
        paletteJson: JSON.stringify(palette),
        layoutJson: JSON.stringify(layout),
        assetsJson: JSON.stringify(assets),
      };
      if (saveSubBrand) body.subBrand = saveSubBrand;
      const created = await fetchApi('/api/travel/flyer-templates', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      notify?.success?.(`Template "${trimmedName}" saved`);
      setShowSaveModal(false);
      try {
        if (created?.id && setSearchParams) {
          setSearchParams({ template: String(created.id) });
        }
      } catch (_e) {
        /* no-op — URL update is best-effort */
      }
      if (created?.id) {
        setLoadedTemplate({
          id: created.id,
          name: created.name || trimmedName,
          subBrand: created.subBrand || null,
        });
      }
    } catch (err) {
      if (!err?.status) {
        notify?.error?.(err?.message || 'Failed to save template');
      }
    } finally {
      setSaving(false);
    }
  };

  const selected = selectedIdx != null ? layout[selectedIdx] : null;

  return (
    <div style={pageWrap} data-testid="marketing-flyer-studio">
      <header style={headerWrap}>
        <div>
          <h1 style={headingStyle}>
            <FileImage size={28} aria-hidden /> Marketing Flyer Studio
          </h1>
          <p style={subtitleStyle}>
            Build branded flyers for TMC / RFU / Travel Stall / Visa Sure.
            Add blocks to the canvas, set the palette, then save as a reusable
            template.
          </p>
        </div>
        <div style={headerActions}>
          <button
            type="button"
            onClick={openSaveModal}
            style={savePrimaryBtn}
            data-testid="save-as-template-button"
            aria-label="Save current composer state as a new template"
          >
            <Save size={14} aria-hidden /> Save as Template
          </button>
        </div>
      </header>

      {loading && (
        <div role="status" style={statusBanner} data-testid="loading-template">
          <Loader size={14} aria-hidden /> Loading template&hellip;
        </div>
      )}
      {!loading && loadedTemplate && (
        <div role="status" style={statusBanner} data-testid="loaded-template-banner">
          <strong>Editing:</strong> {loadedTemplate.name}
          {loadedTemplate.subBrand ? ` — ${loadedTemplate.subBrand.toUpperCase()}` : ''}
        </div>
      )}

      {/* ── Editor: toolbar | canvas | properties (Slice 1) ───────────── */}
      <div data-testid="flyer-editor" style={editorWrap}>
        <div style={toolbarStyle}>
          <button type="button" onClick={() => addBlock('text')} style={toolBtn} data-testid="flyer-add-text">
            + Text
          </button>
          <button type="button" onClick={() => addBlock('image')} style={toolBtn} data-testid="flyer-add-image">
            + Image
          </button>
          <button type="button" onClick={() => addBlock('price')} style={toolBtn} data-testid="flyer-add-price">
            + Price
          </button>
          <button type="button" onClick={() => addBlock('cta')} style={toolBtn} data-testid="flyer-add-cta">
            + CTA
          </button>
          <button type="button" onClick={() => addBlock('logo')} style={toolBtn} data-testid="flyer-add-logo">
            + Logo
          </button>
          <button
            type="button"
            onClick={() => { setAiDestination(''); setAiAudience(''); setShowCopyModal(true); }}
            style={toolBtn}
            data-testid="flyer-ai-copy"
            aria-label="Generate AI marketing copy"
          >
            <Sparkles size={14} aria-hidden /> AI Copy
          </button>
          <button
            type="button"
            onClick={() => { setAiDestination(''); setAiAspectRatio('1:1'); setShowImageModal(true); }}
            style={toolBtn}
            data-testid="flyer-ai-image"
            aria-label="Generate AI flyer image"
          >
            <ImageIcon size={14} aria-hidden /> AI Image
          </button>
          <button
            type="button"
            onClick={undo}
            disabled={!undoStack.length}
            style={{ ...toolBtn, opacity: undoStack.length ? 1 : 0.45 }}
            data-testid="flyer-undo"
            aria-label="Undo"
            title="Undo (Ctrl+Z)"
          >
            <Undo2 size={14} aria-hidden /> Undo
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={!redoStack.length}
            style={{ ...toolBtn, opacity: redoStack.length ? 1 : 0.45 }}
            data-testid="flyer-redo"
            aria-label="Redo"
            title="Redo (Ctrl+Shift+Z)"
          >
            <Redo2 size={14} aria-hidden /> Redo
          </button>
          <button
            type="button"
            onClick={() => setSnapToGrid((s) => !s)}
            style={{ ...toolBtn, background: snapToGrid ? 'var(--primary-color, var(--accent-color))' : undefined, color: snapToGrid ? '#fff' : undefined }}
            data-testid="flyer-snap-toggle"
            aria-pressed={snapToGrid}
            title={`Snap to ${GRID}px grid`}
          >
            <Grid3x3 size={14} aria-hidden /> Snap {snapToGrid ? 'on' : 'off'}
          </button>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 10, alignItems: 'flex-end' }}>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)', alignSelf: 'center' }}>Palette</span>
            {PALETTE_KEYS.map((k) => {
              const meta = PALETTE_META[k] || { label: k, hint: k };
              return (
                <span key={k} style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                  <input
                    type="color"
                    aria-label={`${meta.label} colour — ${meta.hint}`}
                    title={`${meta.label}: ${meta.hint}`}
                    data-testid={`palette-${k}`}
                    value={palette[k] || '#000000'}
                    onFocus={commit}
                    onChange={(e) => setPaletteKey(k, e.target.value)}
                    style={swatchStyle}
                  />
                  <span style={{ fontSize: 9, color: 'var(--text-secondary)', lineHeight: 1 }}>{meta.label}</span>
                </span>
              );
            })}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {/* Canvas */}
          <div
            data-testid="flyer-canvas"
            onMouseMove={onCanvasMouseMove}
            onMouseUp={onCanvasMouseUp}
            onMouseLeave={onCanvasMouseUp}
            onClick={(e) => { if (e.target === e.currentTarget) setSelectedIdx(null); }}
            style={{
              ...canvasStyle,
              background: palette.bgHex || '#FFFFFF',
              // Faint grid overlay while snap is on — a visual cue for the
              // GRID step blocks snap to (pure CSS; not part of the export).
              backgroundImage: snapToGrid
                ? `linear-gradient(to right, rgba(0,0,0,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(0,0,0,0.06) 1px, transparent 1px)`
                : undefined,
              backgroundSize: snapToGrid ? `${GRID}px ${GRID}px` : undefined,
            }}
          >
            {layout.map((b, idx) => {
              const blockColor = b.type === 'price'
                ? (palette.secondaryHex || '#C89A4E')
                : b.type === 'cta'
                  ? (palette.primaryHex || '#122647')
                  : (b.color || palette.textHex || '#222222');
              return (
                <div
                  key={idx}
                  data-testid={`flyer-block-${idx}`}
                  onMouseDown={(e) => onBlockMouseDown(e, idx)}
                  onClick={(e) => { e.stopPropagation(); setSelectedIdx(idx); }}
                  style={{
                    position: 'absolute',
                    left: b.x || 0,
                    top: b.y || 0,
                    width: b.width || 100,
                    height: b.height || 40,
                    boxSizing: 'border-box',
                    padding: 4,
                    overflow: 'hidden',
                    cursor: 'move',
                    border: selectedIdx === idx
                      ? '2px solid var(--primary-color, var(--accent-color))'
                      : '1px dashed rgba(0,0,0,0.25)',
                    color: blockColor,
                    fontSize: b.fontSize || 16,
                    fontFamily: FONT_CSS[b.font] || undefined,
                    fontWeight: (b.bold || b.type === 'cta') ? 700 : undefined,
                    fontStyle: b.italic ? 'italic' : undefined,
                    textDecoration: b.underline ? 'underline' : undefined,
                    textAlign: b.align || undefined,
                  }}
                >
                  {SRC_TYPES.has(b.type)
                    ? (b.src
                      ? <img src={b.src} alt="" style={{ maxWidth: '100%', maxHeight: '100%' }} />
                      : <span style={{ fontSize: 11, opacity: 0.5 }}>{b.type === 'logo' ? 'Logo' : 'Image'} — set URL →</span>)
                    : (b.content || '')}
                  {selectedIdx === idx && (
                    <span
                      data-testid={`flyer-resize-${idx}`}
                      onMouseDown={(e) => onResizeMouseDown(e, idx)}
                      role="button"
                      aria-label="Resize block"
                      style={{
                        position: 'absolute',
                        right: 0,
                        bottom: 0,
                        width: 12,
                        height: 12,
                        background: 'var(--primary-color, var(--accent-color))',
                        border: '1px solid #fff',
                        borderRadius: 2,
                        cursor: 'nwse-resize',
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {/* Properties */}
          <div style={propsPanel} data-testid="flyer-properties">
            {!selected ? (
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>
                Select a block to edit it — or use <strong>+ Text</strong> / <strong>+ Image</strong> to add one.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <strong style={{ fontSize: 12, textTransform: 'capitalize' }}>
                  {selected.type} block
                </strong>
                {SRC_TYPES.has(selected.type) ? (
                  <>
                    <label style={propLabel}>
                      {selected.type === 'logo' ? 'Logo URL' : 'Image URL'}
                      <input
                        type="text"
                        aria-label="Image URL"
                        value={selected.src || ''}
                        onFocus={commit}
                        onChange={(e) => updateBlock(selectedIdx, { src: e.target.value })}
                        style={propInput}
                        placeholder="https://… or /uploads/…"
                      />
                    </label>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      data-testid="flyer-image-file"
                      style={{ display: 'none' }}
                      onChange={(e) => handleUploadImage(e.target.files && e.target.files[0], selectedIdx)}
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current && fileInputRef.current.click()}
                      disabled={uploading}
                      data-testid="flyer-image-upload"
                      style={toolBtn}
                    >
                      {uploading ? 'Uploading…' : 'Upload image'}
                    </button>
                  </>
                ) : (
                  <>
                    <label style={propLabel}>
                      Text
                      <textarea
                        aria-label="Block text"
                        value={selected.content || ''}
                        onFocus={commit}
                        onChange={(e) => updateBlock(selectedIdx, { content: e.target.value })}
                        rows={3}
                        style={propInput}
                      />
                    </label>
                    {selected.type === 'text' ? (
                      <label style={propLabel}>
                        Colour
                        <input
                          type="color"
                          aria-label="Text colour"
                          value={selected.color || '#222222'}
                          onFocus={commit}
                          onChange={(e) => updateBlock(selectedIdx, { color: e.target.value })}
                          style={{ ...propInput, padding: 2, height: 30 }}
                        />
                      </label>
                    ) : (
                      <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0 }}>
                        Colour is applied automatically from the brand palette
                        ({selected.type === 'price' ? 'secondary' : 'primary'}).
                      </p>
                    )}
                    <label style={propLabel}>
                      Font size
                      <input
                        type="number"
                        aria-label="Font size"
                        value={selected.fontSize || 16}
                        onFocus={commit}
                        onChange={(e) => updateBlock(selectedIdx, { fontSize: Number(e.target.value) || 16 })}
                        style={propInput}
                      />
                    </label>
                    <label style={propLabel}>
                      Font family
                      <select
                        aria-label="Font family"
                        data-testid="flyer-font-family"
                        value={selected.font || 'sans'}
                        onFocus={commit}
                        onChange={(e) => updateBlock(selectedIdx, { font: e.target.value })}
                        style={propInput}
                      >
                        {FONT_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        data-testid="flyer-bold"
                        aria-label="Bold"
                        aria-pressed={!!selected.bold}
                        onClick={() => { commit(); updateBlock(selectedIdx, { bold: !selected.bold }); }}
                        style={{ ...styleToggleBtn, fontWeight: 700, ...(selected.bold ? styleToggleActive : {}) }}
                      >
                        B
                      </button>
                      <button
                        type="button"
                        data-testid="flyer-italic"
                        aria-label="Italic"
                        aria-pressed={!!selected.italic}
                        onClick={() => { commit(); updateBlock(selectedIdx, { italic: !selected.italic }); }}
                        style={{ ...styleToggleBtn, fontStyle: 'italic', ...(selected.italic ? styleToggleActive : {}) }}
                      >
                        I
                      </button>
                      <button
                        type="button"
                        data-testid="flyer-underline"
                        aria-label="Underline"
                        aria-pressed={!!selected.underline}
                        onClick={() => { commit(); updateBlock(selectedIdx, { underline: !selected.underline }); }}
                        style={{ ...styleToggleBtn, textDecoration: 'underline', ...(selected.underline ? styleToggleActive : {}) }}
                      >
                        U
                      </button>
                      <span style={{ width: 1, background: 'var(--border-color)', margin: '0 2px' }} />
                      {ALIGN_OPTIONS.map((a) => (
                        <button
                          key={a.value}
                          type="button"
                          data-testid={`flyer-align-${a.value}`}
                          aria-label={a.aria}
                          aria-pressed={(selected.align || 'left') === a.value}
                          onClick={() => { commit(); updateBlock(selectedIdx, { align: a.value }); }}
                          style={{ ...styleToggleBtn, ...((selected.align || 'left') === a.value ? styleToggleActive : {}) }}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  {['x', 'y', 'width', 'height'].map((dim) => (
                    <label key={dim} style={{ ...propLabel, flex: 1 }}>
                      {dim}
                      <input
                        type="number"
                        aria-label={dim}
                        value={selected[dim] || 0}
                        onFocus={commit}
                        onChange={(e) => updateBlock(selectedIdx, { [dim]: Math.max(0, Number(e.target.value) || 0) })}
                        style={propInput}
                      />
                    </label>
                  ))}
                </div>
                <button type="button" onClick={() => removeBlock(selectedIdx)} style={deleteBtn} data-testid="flyer-delete-block">
                  Delete block
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* S71 — AI Copy modal */}
      {showCopyModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="ai-copy-heading"
          style={modalOverlay}
          data-testid="ai-copy-modal"
        >
          <form onSubmit={handleSuggestCopy} style={modalDialog}>
            <h2 id="ai-copy-heading" style={modalHeading}>Generate AI marketing copy</h2>
            <p style={modalHint}>
              Returns a headline, body paragraph, and CTA. Three new text blocks
              will be added to the canvas — drag and restyle as needed.
            </p>
            <label style={modalLabel}>
              Destination *
              <input
                type="text"
                value={aiDestination}
                onChange={(e) => setAiDestination(e.target.value)}
                style={modalInput}
                aria-label="Destination"
                data-testid="ai-copy-destination"
                placeholder="e.g. Bali, Greece, Kashmir"
                autoFocus
              />
            </label>
            <label style={modalLabel}>
              Target audience (optional)
              <input
                type="text"
                value={aiAudience}
                onChange={(e) => setAiAudience(e.target.value)}
                style={modalInput}
                aria-label="Target audience"
                data-testid="ai-copy-audience"
                placeholder="e.g. school principals, young families"
              />
            </label>
            <div style={modalActions}>
              <button
                type="button"
                onClick={() => setShowCopyModal(false)}
                style={secondaryBtn}
                disabled={aiBusy}
                data-testid="ai-copy-cancel"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={aiBusy}
                style={savePrimaryBtn}
                data-testid="ai-copy-submit"
              >
                {aiBusy ? 'Generating…' : 'Generate'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* S72 — AI Image modal */}
      {showImageModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="ai-image-heading"
          style={modalOverlay}
          data-testid="ai-image-modal"
        >
          <form onSubmit={handleSuggestImage} style={modalDialog}>
            <h2 id="ai-image-heading" style={modalHeading}>Generate AI flyer image</h2>
            <p style={modalHint}>
              {selectedIdx != null && layout[selectedIdx]?.type === 'image'
                ? 'Replaces the selected image block.'
                : 'Adds a new image block to the canvas.'}{' '}
              <strong>Heads up:</strong> the returned URL expires after ~1 hour —
              save the template promptly to capture the image.
            </p>
            <label style={modalLabel}>
              Destination *
              <input
                type="text"
                value={aiDestination}
                onChange={(e) => setAiDestination(e.target.value)}
                style={modalInput}
                aria-label="Destination"
                data-testid="ai-image-destination"
                placeholder="e.g. Bali, Greece, Kashmir"
                autoFocus
              />
            </label>
            <label style={modalLabel}>
              Aspect ratio
              <select
                value={aiAspectRatio}
                onChange={(e) => setAiAspectRatio(e.target.value)}
                style={modalInput}
                aria-label="Aspect ratio"
                data-testid="ai-image-aspect"
              >
                <option value="1:1">1:1 (square)</option>
                <option value="9:16">9:16 (portrait)</option>
                <option value="16:9">16:9 (landscape)</option>
              </select>
            </label>
            <div style={modalActions}>
              <button
                type="button"
                onClick={() => setShowImageModal(false)}
                style={secondaryBtn}
                disabled={aiBusy}
                data-testid="ai-image-cancel"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={aiBusy}
                style={savePrimaryBtn}
                data-testid="ai-image-submit"
              >
                {aiBusy ? 'Generating…' : 'Generate'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* "Save as Template" modal — name + sub-brand; serialises palette/layout/assets. */}
      {showSaveModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="save-template-heading"
          style={modalOverlay}
          data-testid="save-template-modal"
        >
          <form onSubmit={handleSaveTemplate} style={modalDialog} data-testid="save-template-form">
            <h2 id="save-template-heading" style={modalHeading}>
              Save as Template
            </h2>
            <p style={modalHint}>
              Capture the current palette + layout + assets as a reusable
              template. You can find it later on the Flyer Templates list page.
            </p>
            <label style={modalLabel}>
              Template name *
              <input
                type="text"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                style={modalInput}
                aria-label="Template name"
                data-testid="save-template-name"
                placeholder="e.g. Summer Europe — Class IX-X"
                autoFocus
              />
            </label>
            <label style={modalLabel}>
              Sub-brand
              <select
                value={saveSubBrand}
                onChange={(e) => setSaveSubBrand(e.target.value)}
                style={modalInput}
                aria-label="Sub-brand"
                data-testid="save-template-sub-brand"
              >
                {SAVE_SUB_BRAND_OPTIONS.map((opt) => (
                  <option key={opt.value || 'none'} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <div style={modalActions}>
              <button
                type="button"
                onClick={closeSaveModal}
                style={secondaryBtn}
                disabled={saving}
                data-testid="save-template-cancel"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                style={savePrimaryBtn}
                data-testid="save-template-submit"
              >
                {saving ? 'Saving…' : 'Save Template'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

const pageWrap = { padding: 24, maxWidth: 1200, margin: '0 auto' };
const headerWrap = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 16 };
const headerActions = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' };
const headingStyle = { display: 'flex', alignItems: 'center', gap: 10, margin: 0, marginBottom: 4, color: 'var(--text-primary)' };
const subtitleStyle = { color: 'var(--text-secondary)', margin: 0, maxWidth: 720, lineHeight: 1.5 };
const statusBanner = { padding: '12px 16px', borderRadius: 8, background: 'var(--surface-color)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', fontSize: 13, lineHeight: 1.5, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };

const editorWrap = { display: 'flex', flexDirection: 'column', gap: 12 };
const toolbarStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 10px', borderRadius: 8, background: 'var(--surface-color)', border: '1px solid var(--border-color)' };
const toolBtn = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 6, fontSize: 13, fontWeight: 600, background: 'var(--primary-color, var(--accent-color))', color: 'var(--accent-text, #fff)', border: 'none', cursor: 'pointer' };
const swatchStyle = { width: 26, height: 26, padding: 0, border: '1px solid var(--border-color)', borderRadius: 4, cursor: 'pointer', background: 'transparent' };
const styleToggleBtn = { minWidth: 30, height: 28, padding: '0 6px', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--input-bg)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13, lineHeight: 1 };
const styleToggleActive = { background: 'var(--primary-color, var(--accent-color))', color: '#fff', borderColor: 'transparent' };
// Canvas reads as a "sheet of paper" floating on the page. Stronger
// shadow + a neutral semi-transparent border so the boundary stays
// visible in BOTH themes — in light mode the cream palette.bgHex
// otherwise blends into the cream page background, and in dark mode
// var(--border-color) alone is too subtle against the dark surround.
const canvasStyle = {
  position: 'relative',
  width: CANVAS_W,
  height: CANVAS_H,
  flexShrink: 0,
  borderRadius: 10,
  border: '1px solid rgba(0,0,0,0.18)',
  boxShadow: '0 14px 48px rgba(0,0,0,0.32), 0 4px 12px rgba(0,0,0,0.18)',
  overflow: 'hidden',
};
const propsPanel = { flex: '1 1 240px', minWidth: 220, padding: 12, borderRadius: 8, background: 'var(--surface-color)', border: '1px solid var(--border-color)' };
const propLabel = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text-secondary)' };
const propInput = { padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--bg-color, rgba(255,255,255,0.05))', color: 'var(--text-primary)', fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box' };
const deleteBtn = { padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, background: 'transparent', color: '#A8323F', border: '1px solid #A8323F', cursor: 'pointer' };

const savePrimaryBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 6, fontWeight: 600, fontSize: 13, background: 'var(--primary-color, var(--accent-color))', color: 'var(--accent-text, #fff)', border: 'none', cursor: 'pointer' };
const secondaryBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 6, fontWeight: 600, fontSize: 13, background: 'var(--surface-color)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', cursor: 'pointer' };
// Backdrop + dialog chrome shared by the three Flyer Studio modals (Save
// as Template / AI Copy / AI Image). Deeper dim + blur defeats the
// readable-text-bleeding-through-backdrop look; opaque `--bg-color` on
// the dialog defeats `--surface-color`'s glassmorphic rgba.
const modalOverlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 };
const modalDialog = { background: 'var(--bg-color)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 20, width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.4)' };
const modalHeading = { margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' };
const modalHint = { margin: 0, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 };
const modalLabel = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-secondary)' };
const modalInput = { padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--bg-color, rgba(255,255,255,0.05))', color: 'var(--text-primary)', fontSize: 13, outline: 'none' };
const modalActions = { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 };
