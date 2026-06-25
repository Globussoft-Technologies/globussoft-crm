// Travel CRM — Brochure Engine page.
//
// Wraps the agentic-orchcrm brochure engine (vendored under <repo>/agentic-orchcrm)
// as a first-class sidebar feature. Operators submit a brief, optionally build a
// brand kit (with a visual logo placer), pick a model strategy, see a pre-run cost
// estimate, and watch the live multi-agent trace as the orchestrator delegates to
// specialists and renders an A4 PDF. Generated PDFs persist as TravelBrochure rows.
//
// Backend contract (backend/routes/travel_brochures.js):
//   POST   /api/travel/brochures/runs           { goal, sectorKey, styleKey?, brand?, models?, strategy?, tripId?, itineraryId? } → { runId, brochureId, status }
//   GET    /api/travel/brochures/runs/:runId    poll snapshot
//   GET    /api/travel/brochures/runs/:runId/stream  SSE live trace
//   GET    /api/travel/brochures/sectors        list available sectors + style keys
//   GET    /api/travel/brochures/models         model catalog (picker + cost estimate)
//   GET    /api/travel/brochures                tenant history (newest first, ≤100)
//   GET    /api/travel/brochures/:id            fetch one row
//   DELETE /api/travel/brochures/:id            soft-archive
//
// Style vocabulary mirrors ItineraryTemplates.jsx — CSS-var driven, inline styles,
// no Tailwind. Primary CTA uses var(--primary-color, var(--accent-color)) so the
// wellness theme override + generic theme both render correctly (per CLAUDE.md).
//
// Brand kit + logo placer + model picker + cost estimate + agent cards are ports of
// agentic-orchcrm/apps/web/src/{components/CommandConsole,components/LogoPlacer,
// app/settings/page,lib/useOrchestration}. Keep behaviour aligned with the engine.
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
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
  Cpu,
  Users,
  DollarSign,
  Move,
} from 'lucide-react';
import { fetchApi, getAuthToken } from '../../utils/api';
import { useNotify } from '../../utils/notify';

const DEFAULT_SECTOR = 'travel';

// Rewrite legacy `/brochure-assets/...` URLs (stored on older brochure rows) to
// the proxy-friendly `/api/brochure-assets/...` form. The backend mounts the
// static dir at both paths but Vite's dev proxy only forwards /api/*.
function normalizeBrochureUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (url.startsWith('/brochure-assets/')) return '/api' + url;
  return url;
}

// Ready-made prompts — clicking a chip pastes the full brief into the input box.
const PROMPT_BRIEFS = [
  `Create a luxury travel brochure for my agency.
AGENCY: Sakura Trails — Bengaluru, India
CONTACT: +91 98800 12345 · hello@sakuratrails.in · www.sakuratrails.in
SOCIAL: Instagram, WhatsApp, Facebook
TRIP: Spirit of Japan — 8 Days · 5 Cities · Small-Group Luxury
DATES / SEASON: Departures late Mar–Apr 2026 (cherry-blossom season) & Oct–Nov 2026 (autumn foliage)
GROUP SIZE: Limited to 14 travellers
TAGLINE: Where Ancient Grace Meets Neon Dreams
ROUTE (in travel order): Tokyo → Hakone → Kyoto → Nara → Osaka
DAY BY DAY:
Day 1 — Arrive Tokyo: Private airport transfer; evening walk through Shibuya Crossing and dinner in Shinjuku.
Day 2 — Tokyo: Senso-ji Temple, Meiji Shrine, teamLab digital art museum, sushi-making class.
Day 3 — Tokyo → Hakone: Bullet train to Hakone; Lake Ashi cruise, Owakudani valley, ryokan stay with onsen.
Day 4 — Hakone → Kyoto: Mt. Fuji views en route; arrive Kyoto, evening in the historic Gion district.
Day 5 — Kyoto: Fushimi Inari shrine, Arashiyama bamboo grove, Kinkaku-ji golden pavilion, tea ceremony.
Day 6 — Nara day trip: Todai-ji Great Buddha, the friendly deer of Nara Park, return to Kyoto.
Day 7 — Kyoto → Osaka: Osaka Castle, Dotonbori street food, Umeda Sky Building at sunset.
Day 8 — Depart Osaka: Private transfer to Kansai International Airport.
INCLUSIONS:
Flights & visa: return international flights + Japan e-visa assistance
Hotels: 7 nights — 4-star city hotels + 1 traditional ryokan, twin sharing
Meals: daily breakfast + 3 special dinners (kaiseki, teppanyaki, izakaya)
Transport: all bullet-train (Shinkansen) journeys + private airport and city transfers
Guidance: English-speaking tour manager throughout
Insurance: comprehensive travel insurance included
PRICING:
₹3,19,999 per person (twin sharing)
Single Supplement: ₹52,000
Deposit: ₹60,000 to reserve
CALL TO ACTION:
Limited seats — book by 31 January 2026.
MAP:
Use the default 2D map showing the route Tokyo → Hakone → Kyoto → Nara → Osaka with clear travel-path connections and city markers.`,
  `Create a premium pilgrimage brochure for my agency.
AGENCY: Al-Noor Travels — Hyderabad, India
CONTACT: +91 99000 55667 · umrah@alnoortravels.in · www.alnoortravels.in
SOCIAL: Instagram, WhatsApp, Facebook
TRIP: Sacred Journey — Makkah & Madinah — 12 Days · Premium Umrah · Family Package
DATES / SEASON: Ramadan 2026 departures + year-round group dates
GROUP SIZE: Small groups of up to 20 pilgrims
TAGLINE: A Journey of the Heart, Guided with Care
ROUTE (in travel order): Jeddah → Makkah → Madinah → Jeddah
DAY BY DAY:
Day 1 — Arrive Jeddah: Meet-and-assist at the airport; private transfer to Makkah (hotel within 200m of Masjid al-Haram).
Day 2 — Makkah: Perform Umrah with a dedicated religious guide — Tawaf, Sa'i, and supplications.
Day 3 — Makkah: Spiritual rest day; optional second Umrah; lectures on the rites and their meaning.
Day 4 — Makkah Ziyarat: Guided visit to Jabal al-Noor (Cave of Hira), Mina, Arafat, and Muzdalifah.
Day 5 — Makkah: Free day for worship and reflection at the Haram.
Day 6 — Makkah → Madinah: Haramain high-speed train to Madinah; check in near Masjid an-Nabawi.
Day 7 — Madinah: Prayers at the Prophet's Mosque; visit to Rawdah (subject to permit).
Day 8 — Madinah Ziyarat: Quba Mosque, Mount Uhud, Qiblatain Mosque, and the trenches of Khandaq.
Day 9 — Madinah: Day of worship; Islamic-heritage walking tour with the guide.
Day 10 — Madinah: Free day; optional dates-farm and local-market visit.
Day 11 — Madinah → Jeddah: Transfer to Jeddah; brief visit to the historic Al-Balad old town.
Day 12 — Depart Jeddah: Assisted transfer to King Abdulaziz International Airport.
INCLUSIONS:
Flights & visa: return flights + full Umrah visa processing
Hotels: 5 nights premium Makkah hotel within 200m of Haram + 4 nights Madinah Hilton, family rooms
Meals: daily breakfast and dinner (Indian & Arabic cuisine)
Transport: Haramain high-speed train + all private AC ground transfers
Guidance: experienced English/Urdu-speaking religious guide (mu'allim) throughout
Insurance: comprehensive travel and health insurance
ADDITIONAL SERVICES:
Ihram kit and ziyarat guidebook for every pilgrim; ladies' group attendant; 24×7 on-ground support desk; wheelchair assistance on request.
RITUALS & GUIDANCE:
Step-by-step support for the Umrah rites; daily group prayers; a pre-departure orientation covering ihram, the rites, and the etiquette of the holy cities.
PRICING:
₹2,85,000 per pilgrim (quad sharing)
Family-room upgrade: ₹35,000 per person
Deposit: ₹50,000 to reserve
CALL TO ACTION:
Ramadan seats fill fast — reserve by 15 February 2026.
MAP:
Use a 3D map of Saudi Arabia highlighting the route Jeddah → Makkah → Madinah with clear travel-path connections and city markers.`,
  `Create a luxury travel brochure for my agency.
AGENCY: Wanderlust Journeys — Bengaluru, India
CONTACT: +91 98765 43210 · hello@wanderlustjourneys.in · www.wanderlustjourneys.in
SOCIAL: Instagram, WhatsApp, Facebook
TRIP: Soul of India — Royal Rajasthan & the Sacred Ganges — 10 Days · 5 Cities · Boutique Luxury
DATES / SEASON: Oct 2025 – Mar 2026 (cool, festival-rich season)
GROUP SIZE: Limited to 12 travellers
TAGLINE: Palaces, Prayers & a Thousand Colours
ROUTE (in travel order): Delhi → Agra → Jaipur → Udaipur → Varanasi
DAY BY DAY:
Day 1 — Arrive Delhi: Private transfer; evening at India Gate and a welcome dinner of Mughlai cuisine.
Day 2 — Delhi: Old & New Delhi — Jama Masjid, Qutub Minar, Humayun's Tomb, a rickshaw ride in Chandni Chowk.
Day 3 — Delhi → Agra: Drive to Agra; sunset at the Taj Mahal and Agra Fort.
Day 4 — Agra → Jaipur: En route visit Fatehpur Sikri; arrive the Pink City of Jaipur.
Day 5 — Jaipur: Amber Fort with elephant welcome, City Palace, Hawa Mahal, Jantar Mantar.
Day 6 — Jaipur: Block-printing workshop, local bazaars, evening folk-dance dinner at a heritage haveli.
Day 7 — Jaipur → Udaipur: Flight to Udaipur, the City of Lakes; evening boat ride on Lake Pichola.
Day 8 — Udaipur: City Palace, Jagdish Temple, Saheliyon Ki Bari gardens, the vintage-car museum.
Day 9 — Udaipur → Varanasi: Flight to Varanasi; the spectacular Ganga Aarti ceremony at dusk.
Day 10 — Varanasi & depart: Sunrise boat ride on the Ganges; Sarnath visit; transfer to the airport.
INCLUSIONS:
Flights & visa: domestic flights (Jaipur–Udaipur–Varanasi) + e-visa assistance
Hotels: 9 nights in heritage palace-hotels and 5-star boutique stays, twin sharing
Meals: daily breakfast + 4 signature dinners (royal Rajasthani thali, lakeside fine dining)
Transport: private chauffeured SUV + all transfers, plus the listed flights
Guidance: expert local guides in every city + a tour manager throughout
Insurance: comprehensive travel insurance included
FESTIVALS & EXPERIENCES:
Time your journey with Diwali (festival of lights) or Holi (festival of colours); optional cooking class, turban-tying, henna, and a private sitar performance.
WHY TRAVEL WITH WANDERLUST:
Hand-picked palace stays, small groups, a 24×7 concierge, fully customisable departures, and a give-back programme supporting local artisans.
OPTIONAL ADD-ONS:
2-night Ayurveda & wellness retreat in Kerala; a tiger safari at Ranthambore; a night in a luxury desert camp at Jaisalmer.
PRICING:
₹2,49,999 per person (twin sharing)
Single Supplement: ₹48,000
Deposit: ₹50,000 to reserve
CALL TO ACTION:
Festival-season seats are limited — book by 30 September 2025.`,
];

// ── Model picker / cost estimate constants (ported from settings/page.tsx) ──
const TIER_INFO = {
  reasoning: { label: 'Reasoning', hint: 'CEO planning + the brochure composer. The quality lever.' },
  balanced: { label: 'Balanced', hint: 'General analysis / mid-weight steps.' },
  fast: { label: 'Fast', hint: 'Research & tool-running — keep this cheap.' },
  writing: { label: 'Writing', hint: "Copywriting — the brochure's words." },
};
const STRATEGY_LABEL = {
  recommended: 'Recommended (Auto)',
  cheapest: 'Cheapest',
  smartest: 'Smartest',
  custom: 'Custom (per-tier)',
};
const STRATEGY_HINT = {
  recommended: 'Capable models where the output is seen, cheap models for research/plumbing.',
  cheapest: 'Lowest cost on every tier.',
  smartest: 'Most capable model on every tier (premium).',
  custom: 'You choose each tier yourself below.',
};
// Rough token mix of one brochure run, per tier — for the cost estimate.
const TIER_TOKENS = {
  reasoning: { input: 16000, output: 7000 },
  fast: { input: 8000, output: 3000 },
  writing: { input: 5000, output: 2500 },
  balanced: { input: 2000, output: 1000 },
};
const ALL_TIERS = ['reasoning', 'balanced', 'fast', 'writing'];

// Replicates crm-bridge.ts strategyAssignment so the pre-run estimate matches what
// the engine will actually route. Returns a per-tier model-id map, or null when
// nothing is available / strategy is custom.
function resolveStrategyAssignment(models, strategy) {
  const avail = (models || []).filter((m) => m.available);
  if (!avail.length || strategy === 'custom') return null;
  const blended = (m) => m.inputPer1M + m.outputPer1M;
  const cheapest = [...avail].sort((a, b) => blended(a) - blended(b) || b.intelligence - a.intelligence)[0];
  const smartest = [...avail].sort((a, b) => b.intelligence - a.intelligence || blended(b) - blended(a))[0];
  const balanced = [...avail].sort(
    (a, b) => b.intelligence * 2 + b.costEff - (a.intelligence * 2 + a.costEff) || blended(a) - blended(b),
  )[0];
  if (strategy === 'cheapest') return { reasoning: cheapest.id, balanced: cheapest.id, fast: cheapest.id, writing: cheapest.id };
  if (strategy === 'smartest') return { reasoning: smartest.id, balanced: smartest.id, fast: smartest.id, writing: smartest.id };
  // recommended
  return { reasoning: balanced.id, balanced: balanced.id, fast: cheapest.id, writing: balanced.id };
}

// Fold the raw SSE trace into per-agent cards + running totals (ported from
// useOrchestration.ts fold()). Pure over the events array → safe in useMemo.
function foldAgents(events) {
  const byKey = new Map();
  const order = [];
  const totals = { inputTokens: 0, outputTokens: 0, calls: 0, billedUsd: 0 };
  const ensure = (key, parentKey) => {
    if (!key) return null;
    let a = byKey.get(key);
    if (!a) {
      a = { key, name: key, tier: '', status: 'working', parentKey: parentKey || null, inputTokens: 0, outputTokens: 0, calls: 0, costUsd: 0 };
      byKey.set(key, a);
      order.push(key);
    } else if (parentKey && !a.parentKey) {
      a.parentKey = parentKey;
    }
    return a;
  };
  for (const e of events) {
    const d = e.data || {};
    const key = e.agentKey || e.parentAgentKey;
    switch (e.type) {
      case 'agent.started': {
        const a = ensure(key, e.parentAgentKey);
        if (a) { if (d.name) a.name = d.name; if (d.tier) a.tier = d.tier; a.status = 'working'; }
        break;
      }
      case 'delegation.started':
        ensure(key, e.parentAgentKey);
        break;
      case 'agent.message': {
        const a = ensure(key, e.parentAgentKey);
        if (a && d.final) a.status = 'done';
        break;
      }
      case 'delegation.completed': {
        const a = ensure(key, e.parentAgentKey);
        if (a) a.status = 'done';
        break;
      }
      case 'usage': {
        const a = ensure(key, e.parentAgentKey);
        if (a) {
          a.inputTokens += d.inputTokens || 0;
          a.outputTokens += d.outputTokens || 0;
          a.calls += 1;
          a.costUsd += d.costUsd || 0;
        }
        totals.inputTokens += d.inputTokens || 0;
        totals.outputTokens += d.outputTokens || 0;
        totals.calls += 1;
        totals.billedUsd += d.billedUsd || 0;
        break;
      }
      default:
        break;
    }
  }
  return { agents: order.map((k) => byKey.get(k)), totals };
}

export default function BrochureEngine() {
  const notify = useNotify();
  const [sectors, setSectors] = useState([]);
  const [sectorKey] = useState(DEFAULT_SECTOR); // fixed — Travel is the only sector
  const [styleKey, setStyleKey] = useState('editorial-sakura');
  const [goal, setGoal] = useState('');
  const [brandOpen, setBrandOpen] = useState(false);
  const [brand, setBrand] = useState({
    name: '', tagline: '', logoUrl: '', accent: '#122647',
    contact: [], socials: [], custom: null,
  });
  const [placerOpen, setPlacerOpen] = useState(false);
  // Model catalog + selection
  const [catalog, setCatalog] = useState({ tiers: [], strategies: [], defaults: {}, models: [] });
  const [strategy, setStrategy] = useState('recommended');
  const [perTier, setPerTier] = useState({}); // advanced overrides { reasoning: id, ... }
  const [modelOpen, setModelOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Run state
  const [running, setRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState(null);
  const [, setActiveBrochureId] = useState(null);
  const [traceEvents, setTraceEvents] = useState([]);
  const [showRawTrace, setShowRawTrace] = useState(false);
  const [result, setResult] = useState(null); // { pdfUrl, billedUsd, result }
  const [pdfBlobUrl, setPdfBlobUrl] = useState(null); // object URL for inline preview
  const [runError, setRunError] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [tab, setTab] = useState('generate');
  const esRef = useRef(null);
  const fileInputRef = useRef(null);
  const activeBrochureIdRef = useRef(null);

  // ─── Initial load: sector catalog + model catalog + history ────────────
  useEffect(() => {
    (async () => {
      try {
        const data = await fetchApi('/api/travel/brochures/sectors');
        if (data && Array.isArray(data.sectors)) setSectors(data.sectors);
      } catch (e) {
        console.warn('[brochures] sector list failed', e);
        setSectors([{ key: 'travel', name: 'Travel Brochure', styles: ['tmc-press', 'editorial-sakura'] }]);
      }
    })();
    (async () => {
      try {
        const data = await fetchApi('/api/travel/brochures/models');
        if (data && Array.isArray(data.models)) {
          setCatalog({
            tiers: Array.isArray(data.tiers) && data.tiers.length ? data.tiers : ALL_TIERS,
            strategies: Array.isArray(data.strategies) && data.strategies.length ? data.strategies : ['recommended', 'cheapest', 'smartest', 'custom'],
            defaults: data.defaults || {},
            models: data.models,
          });
        }
      } catch (e) {
        // Engine not installed → 503. The picker degrades to strategy presets.
        console.warn('[brochures] model catalog unavailable', e);
      }
    })();
    loadHistory();
    // Mount-once: the sector/model/history fetch should not re-run on callback identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // ── Cost estimate (pre-run) — resolve the per-tier selection then sum ──
  const availableModels = useMemo(() => catalog.models.filter((m) => m.available), [catalog.models]);
  const resolvedSelection = useMemo(() => {
    // Advanced per-tier overrides win; else the strategy assignment; else defaults.
    if (strategy === 'custom') {
      const sel = {};
      for (const t of ALL_TIERS) sel[t] = perTier[t] || catalog.defaults[t] || '';
      return sel;
    }
    const assign = resolveStrategyAssignment(catalog.models, strategy);
    if (assign) return assign;
    return catalog.defaults || {};
  }, [strategy, perTier, catalog]);

  const costEstimate = useMemo(() => {
    const byId = new Map(catalog.models.map((m) => [m.id, m]));
    let cost = 0;
    let known = catalog.models.length > 0;
    for (const tier of Object.keys(TIER_TOKENS)) {
      const m = byId.get(resolvedSelection[tier] || '');
      if (!m) { known = false; continue; }
      const t = TIER_TOKENS[tier];
      cost += (t.input / 1e6) * m.inputPer1M + (t.output / 1e6) * m.outputPer1M;
    }
    return { cost, known };
  }, [catalog.models, resolvedSelection]);

  // ─── Brand-kit logo upload (→ data URI; server-side re-sanitized) ──────
  const onLogoFile = useCallback((file) => {
    if (!file) return;
    if (file.size > 200 * 1024) { notify.error('Logo too large — max 200KB.'); return; }
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
      notify.error('Logo must be PNG, JPEG, WebP, or GIF.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setBrand((b) => ({ ...b, logoUrl: String(reader.result) }));
    reader.readAsDataURL(file);
  }, [notify]);

  // ─── Start a run ───────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (e) => {
    e?.preventDefault?.();
    if (running) return;
    const trimmed = goal.trim();
    if (!trimmed) { notify.error('Please describe the brochure you want to generate.'); return; }
    setRunning(true);
    setRunError(null);
    setResult(null);
    setTraceEvents([]);

    // Build the brand kit payload — drop empties; the backend re-validates everything.
    const brandPayload = {};
    if (brand.name?.trim()) brandPayload.name = brand.name.trim();
    if (brand.tagline?.trim()) brandPayload.tagline = brand.tagline.trim();
    if (brand.logoUrl) brandPayload.logoUrl = brand.logoUrl;
    if (/^#[0-9a-f]{6}$/i.test(brand.accent || '')) brandPayload.colors = { accent: brand.accent };
    const contacts = (brand.contact || []).map((c) => String(c).trim()).filter(Boolean);
    if (contacts.length) brandPayload.contact = contacts;
    const socials = (brand.socials || []).map((s) => String(s).trim()).filter(Boolean);
    if (socials.length) brandPayload.socials = socials;
    if (brand.logoUrl && brand.custom) brandPayload.custom = brand.custom;

    // Model selection: advanced per-tier overrides → `models`; else `strategy`.
    const modelPayload = {};
    if (strategy === 'custom') {
      const sel = {};
      for (const t of ALL_TIERS) if (perTier[t]) sel[t] = perTier[t];
      if (Object.keys(sel).length) modelPayload.models = sel;
    } else {
      modelPayload.strategy = strategy;
    }

    try {
      const body = {
        goal: trimmed,
        sectorKey,
        styleKey, // always explicit — one of editorial-sakura | tmc-press
        ...(Object.keys(brandPayload).length ? { brand: brandPayload } : {}),
        ...modelPayload,
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
      loadHistory();
    } catch (err) {
      setRunning(false);
      setRunError(err?.message || String(err));
      notify.error('Failed to start brochure run.');
    }
    // openStream/pollOnce are stable closures declared below; omitted to avoid a TDZ on the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, goal, sectorKey, styleKey, brand, strategy, perTier, notify, loadHistory]);

  const backfillPdfUrl = useCallback(async (brochureId, attempt = 0) => {
    if (!brochureId) return;
    try {
      const detail = await fetchApi(`/api/travel/brochures/${brochureId}`);
      const url = normalizeBrochureUrl(detail?.pdfUrl || detail?.brochure?.pdfUrl || null);
      const billed = detail?.billedUsd ?? detail?.brochure?.billedUsd;
      if (url || billed != null) {
        // The persisted row is canonical — the SSE run.completed event sometimes
        // omits pdfUrl and/or carries a 0 cost; refresh both from the row.
        setResult((prev) => ({
          ...(prev || { result: null }),
          ...(url ? { pdfUrl: url } : {}),
          ...(billed != null ? { billedUsd: Number(billed) } : {}),
        }));
      }
      if (url) return; // got the URL — done (cost set in the same update)
      if (attempt < 3) setTimeout(() => backfillPdfUrl(brochureId, attempt + 1), 1500);
    } catch (e) {
      console.warn('[brochures] backfill pdfUrl failed', e);
    }
  }, []);

  // ─── SSE stream subscriber ─────────────────────────────────────────────
  const openStream = useCallback((runId) => {
    if (esRef.current) {
      try { esRef.current.close(); } catch { /* ignore */ }
      esRef.current = null;
    }
    const token = getAuthToken();
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
            setResult({ pdfUrl: sseUrl, billedUsd: event.data?.billedUsd || 0, result: event.data?.result || null });
            setRunning(false);
            try { es.close(); } catch { /* ignore */ }
            esRef.current = null;
            loadHistory();
            // Always refresh pdfUrl + billedUsd from the persisted row — the SSE
            // event can omit the URL (`pdf=-`) and/or report a 0 cost.
            if (activeBrochureIdRef.current) backfillPdfUrl(activeBrochureIdRef.current);
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
        if (!running) {
          try { es.close(); } catch { /* ignore */ }
          esRef.current = null;
          pollOnce(runId);
        }
      };
    } catch (e) {
      console.warn('[brochures] SSE failed, falling back to polling', e);
      pollOnce(runId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, loadHistory, backfillPdfUrl]);

  const pollOnce = useCallback(async (runId) => {
    try {
      const snap = await fetchApi(`/api/travel/brochures/runs/${encodeURIComponent(runId)}`);
      if (snap.status === 'completed') {
        setResult({ pdfUrl: normalizeBrochureUrl(snap.pdfUrl) || null, billedUsd: snap.billedUsd, result: null });
        setRunning(false);
        loadHistory();
        if (activeBrochureIdRef.current) backfillPdfUrl(activeBrochureIdRef.current);
      } else if (snap.status === 'failed') {
        setRunError(snap.errorMessage || 'Run failed');
        setRunning(false);
        loadHistory();
      } else {
        setTimeout(() => pollOnce(runId), 3000);
      }
    } catch (e) {
      console.warn('[brochures] poll failed', e);
    }
  }, [loadHistory, backfillPdfUrl]);

  useEffect(() => () => {
    if (esRef.current) { try { esRef.current.close(); } catch { /* ignore */ } esRef.current = null; }
  }, []);

  // Inline PDF preview via a blob: URL. The backend stamps /api/brochure-assets
  // with `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` (global helmet),
  // so a direct <iframe src="/api/brochure-assets/…"> is blocked by the browser
  // ("refused to connect"). Fetching the bytes through the same-origin proxy and
  // framing a local blob: URL sidesteps those response headers entirely. Open /
  // Download still use the direct URL (navigation/download isn't framing).
  useEffect(() => {
    if (!result?.pdfUrl) { setPdfBlobUrl(null); return; }
    let cancelled = false;
    let objectUrl = null;
    (async () => {
      try {
        const resp = await fetch(result.pdfUrl, { credentials: 'same-origin' });
        if (!resp.ok) throw new Error(`pdf fetch ${resp.status}`);
        const blob = await resp.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPdfBlobUrl(objectUrl);
      } catch (e) {
        console.warn('[brochures] inline preview fetch failed; use Open/Download', e);
        if (!cancelled) setPdfBlobUrl(null);
      }
    })();
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [result?.pdfUrl]);

  const handleArchive = useCallback(async (row) => {
    if (!window.confirm(`Archive this brochure?\n\n${row.goal.slice(0, 120)}…`)) return;
    try {
      await fetchApi(`/api/travel/brochures/${row.id}`, { method: 'DELETE' });
      notify.success('Brochure archived.');
      loadHistory();
    } catch {
      notify.error('Failed to archive brochure.');
    }
  }, [notify, loadHistory]);

  const handleSampleBrief = useCallback((text) => setGoal(text), []);

  // Live agent fold + running cost.
  const { agents, totals } = useMemo(() => foldAgents(traceEvents), [traceEvents]);
  const liveCost = result?.billedUsd != null ? Number(result.billedUsd) : totals.billedUsd;

  // The placer needs to know the rough family for its mock (banded vs editorial).
  const placerFamily = styleKey === 'editorial-sakura' ? 'editorial' : 'banded';

  // ─── Render ────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      <div style={pageHeaderRow}>
        <div>
          <h1 style={pageTitle}><Sparkles size={28} aria-hidden /> Brochure Engine</h1>
          <p style={pageSubtitle}>
            AI-powered, agency-grade travel brochures. One brief in, a multi-page A4 PDF out —
            cover, day-by-day itinerary, route map, inclusions, pricing. Powered by the
            agentic orchestration engine vendored under <code style={inlineCode}>agentic-orchcrm/</code>.
          </p>
        </div>
        <div style={tabBar}>
          <button type="button" onClick={() => setTab('generate')} style={tab === 'generate' ? activeTabBtn : tabBtn} data-testid="tab-generate">
            <Wand2 size={14} /> Generate
          </button>
          <button type="button" onClick={() => setTab('history')} style={tab === 'history' ? activeTabBtn : tabBtn} data-testid="tab-history">
            <HistoryIcon size={14} /> History {history.length > 0 ? `(${history.length})` : ''}
          </button>
        </div>
      </div>

      {tab === 'generate' && (
        <div style={twoColLayout}>
          {/* ─── Left: Form panel ──────────────────────────────────────── */}
          <form onSubmit={handleSubmit} style={panel}>
            <h2 style={panelTitle}><FileText size={18} aria-hidden /> Brief</h2>

            <div style={fieldLabel}>
              Sector
              <div style={staticField} data-testid="sector-static">Travel</div>
            </div>
            {currentSector?.description && <p style={fieldHint}>{currentSector.description}</p>}

            <label style={fieldLabel}>
              Template / Style
              <select value={styleKey} onChange={(e) => setStyleKey(e.target.value)} style={selectStyle} disabled={running} data-testid="style-select">
                <option value="editorial-sakura">Editorial Sakura (Default)</option>
                <option value="tmc-press">TMC Press</option>
              </select>
            </label>

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
              <span style={{ ...fieldHint, marginRight: 6 }}>Try a prompt:</span>
              {PROMPT_BRIEFS.map((promptText, i) => (
                <button key={i} type="button" onClick={() => handleSampleBrief(promptText)} style={chipBtn} disabled={running}>
                  Prompt {i + 1}
                </button>
              ))}
            </div>

            {/* Brand kit (collapsible) */}
            <BrandKitPanel
              brand={brand}
              setBrand={setBrand}
              open={brandOpen}
              setOpen={setBrandOpen}
              running={running}
              fileInputRef={fileInputRef}
              onLogoFile={onLogoFile}
              onOpenPlacer={() => setPlacerOpen(true)}
            />

            {/* Model picker (collapsible) */}
            <ModelPickerPanel
              catalog={catalog}
              availableModels={availableModels}
              strategy={strategy}
              setStrategy={setStrategy}
              perTier={perTier}
              setPerTier={setPerTier}
              open={modelOpen}
              setOpen={setModelOpen}
              advancedOpen={advancedOpen}
              setAdvancedOpen={setAdvancedOpen}
              running={running}
              resolvedSelection={resolvedSelection}
              costEstimate={costEstimate}
            />

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
            <h2 style={panelTitle}><Users size={18} aria-hidden /> Live agents</h2>
            {!activeRunId && (
              <div style={emptyStyle}>
                Submit a brief to watch the CEO agent plan, delegate to specialists, and render the PDF.
              </div>
            )}
            {activeRunId && (
              <>
                <div style={runHeaderRow}>
                  <div>
                    <span style={{ ...fieldHint, marginRight: 6 }}>Run id:</span>
                    <code style={inlineCode}>{activeRunId}</code>
                  </div>
                  <span style={liveCostBadge} data-testid="live-cost">
                    <DollarSign size={12} /> {liveCost ? `$${liveCost.toFixed(4)}` : '$0.0000'}
                    <span style={{ opacity: 0.7, marginLeft: 4 }}>
                      · {totals.inputTokens.toLocaleString()} in / {totals.outputTokens.toLocaleString()} out
                    </span>
                  </span>
                </div>

                {/* Agent cards */}
                <div style={agentGrid} data-testid="agent-cards">
                  {agents.length === 0 && (
                    <div style={traceLineMuted}>Engine starting up — first agents arrive in a moment…</div>
                  )}
                  {agents.map((a) => <AgentCard key={a.key} agent={a} />)}
                </div>

                {/* Raw event log (collapsible debug view) */}
                <button type="button" onClick={() => setShowRawTrace((v) => !v)} style={rawToggleBtn} data-testid="toggle-raw-trace">
                  {showRawTrace ? '− Hide' : '+ Show'} raw event log ({traceEvents.length})
                </button>
                {showRawTrace && (
                  <div style={traceBox} data-testid="trace-log">
                    {traceEvents.map((e, i) => <TraceLine key={i} event={e} />)}
                  </div>
                )}

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
                      {result.billedUsd != null && <span style={costBadge}>${Number(result.billedUsd).toFixed(4)}</span>}
                      {result.pdfUrl ? (
                        <>
                          <a href={result.pdfUrl} target="_blank" rel="noopener noreferrer" style={{ ...secondaryBtn, marginLeft: 'auto', textDecoration: 'none' }} data-testid="brochure-open">
                            <ExternalLink size={14} /> Open
                          </a>
                          <a href={result.pdfUrl} download style={{ ...secondaryBtn, textDecoration: 'none' }} data-testid="brochure-download">
                            <Download size={14} /> Download
                          </a>
                        </>
                      ) : (
                        <button type="button" onClick={() => activeBrochureIdRef.current && backfillPdfUrl(activeBrochureIdRef.current)} style={{ ...secondaryBtn, marginLeft: 'auto' }} data-testid="brochure-download-retry">
                          <Download size={14} /> Fetch PDF
                        </button>
                      )}
                    </div>
                    {result.pdfUrl ? (
                      <iframe src={pdfBlobUrl || result.pdfUrl} title="Brochure preview" style={pdfFrame} />
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
          <h2 style={panelTitle}><HistoryIcon size={18} aria-hidden /> Brochure history</h2>
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
                      <td style={td}><div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{new Date(row.createdAt).toLocaleString()}</div></td>
                      <td style={{ ...td, maxWidth: 360 }}><div style={ellipsis2}>{row.goal}</div></td>
                      <td style={td}>
                        <span style={brandBadge}>{row.sectorKey}</span>
                        {row.styleKey && <span style={{ ...brandBadge, marginLeft: 4 }}>{row.styleKey}</span>}
                      </td>
                      <td style={td}>
                        <StatusBadge status={row.status} />
                        {row.errorMessage && <div style={{ fontSize: 11, color: '#b00', marginTop: 4 }} title={row.errorMessage}>{row.errorMessage.slice(0, 80)}</div>}
                      </td>
                      <td style={td}>{row.billedUsd != null ? `$${Number(row.billedUsd).toFixed(4)}` : '—'}</td>
                      <td style={td}>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {row.pdfUrl && <a href={normalizeBrochureUrl(row.pdfUrl)} target="_blank" rel="noopener noreferrer" style={iconBtn} title="Open PDF"><ExternalLink size={14} /></a>}
                          {row.pdfUrl && <a href={normalizeBrochureUrl(row.pdfUrl)} download style={iconBtn} title="Download"><Download size={14} /></a>}
                          <button type="button" onClick={() => handleArchive(row)} style={iconBtn} title="Archive"><Trash2 size={14} /></button>
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

      {/* Visual logo placer modal */}
      {placerOpen && brand.logoUrl && (
        <LogoPlacer
          logoUrl={brand.logoUrl}
          family={placerFamily}
          templateName={styleKey || (placerFamily === 'editorial' ? 'editorial-sakura' : 'tmc-press')}
          accent={brand.accent}
          brandName={brand.name}
          value={brand.custom}
          onSave={(v) => { setBrand((b) => ({ ...b, custom: v })); setPlacerOpen(false); }}
          onClose={() => setPlacerOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Brand kit panel ────────────────────────────────────────────────────────
function BrandKitPanel({ brand, setBrand, open, setOpen, running, fileInputRef, onLogoFile, onOpenPlacer }) {
  const setContactLine = (i, v) => setBrand((b) => {
    const contact = [...(b.contact || [])];
    contact[i] = v;
    return { ...b, contact };
  });
  const addContact = () => setBrand((b) => ({ ...b, contact: [...(b.contact || []), ''] }));
  const removeContact = (i) => setBrand((b) => ({ ...b, contact: (b.contact || []).filter((_, j) => j !== i) }));
  const setSocialLine = (i, v) => setBrand((b) => {
    const socials = [...(b.socials || [])];
    socials[i] = v;
    return { ...b, socials };
  });
  const addSocial = () => setBrand((b) => ({ ...b, socials: [...(b.socials || []), ''] }));
  const removeSocial = (i) => setBrand((b) => ({ ...b, socials: (b.socials || []).filter((_, j) => j !== i) }));

  return (
    <div style={collapsible}>
      <button type="button" onClick={() => setOpen((v) => !v)} style={collapsibleHeader}>
        <ImageIcon size={16} />
        Brand Kit {brand.logoUrl || brand.name ? '(set)' : '(optional)'}
        <span style={{ marginLeft: 'auto', fontSize: 18 }}>{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div style={collapsibleBody}>
          <label style={fieldLabel}>
            Agency name
            <input type="text" value={brand.name} onChange={(e) => setBrand((b) => ({ ...b, name: e.target.value }))} placeholder="Globus Travels" style={inputStyle} disabled={running} />
          </label>
          <label style={fieldLabel}>
            Tagline
            <input type="text" value={brand.tagline} onChange={(e) => setBrand((b) => ({ ...b, tagline: e.target.value }))} placeholder="Crafted journeys, since 1998" style={inputStyle} disabled={running} />
          </label>
          <label style={fieldLabel}>
            Accent colour
            <input type="color" value={brand.accent} onChange={(e) => setBrand((b) => ({ ...b, accent: e.target.value }))} style={{ ...inputStyle, padding: 2, height: 36, width: 60 }} disabled={running} />
          </label>

          {/* Contacts */}
          <div style={fieldLabel}>
            <span>Contact lines <span style={fieldHint}>(phone / email — max 4)</span></span>
            {(brand.contact || []).map((c, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                <input type="text" value={c} onChange={(e) => setContactLine(i, e.target.value)} placeholder="+91 98765 43210" style={inputStyle} disabled={running} />
                <button type="button" onClick={() => removeContact(i)} style={iconBtn} aria-label="Remove contact" disabled={running}><X size={14} /></button>
              </div>
            ))}
            {(brand.contact || []).length < 4 && (
              <button type="button" onClick={addContact} style={chipBtn} disabled={running}>+ Add contact</button>
            )}
          </div>

          {/* Socials */}
          <div style={fieldLabel}>
            <span>Socials <span style={fieldHint}>(handle / network — max 6)</span></span>
            {(brand.socials || []).map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                <input type="text" value={s} onChange={(e) => setSocialLine(i, e.target.value)} placeholder="instagram" style={inputStyle} disabled={running} />
                <button type="button" onClick={() => removeSocial(i)} style={iconBtn} aria-label="Remove social" disabled={running}><X size={14} /></button>
              </div>
            ))}
            {(brand.socials || []).length < 6 && (
              <button type="button" onClick={addSocial} style={chipBtn} disabled={running}>+ Add social</button>
            )}
          </div>

          <label style={fieldLabel}>
            Logo (PNG / JPEG / WebP / GIF · ≤200KB)
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => onLogoFile(e.target.files?.[0])} style={{ flex: 1 }} disabled={running} />
              {brand.logoUrl && (
                <button type="button" onClick={() => { setBrand((b) => ({ ...b, logoUrl: '', custom: null })); if (fileInputRef.current) fileInputRef.current.value = ''; }} style={iconBtn} aria-label="Remove logo" disabled={running}>
                  <X size={14} />
                </button>
              )}
            </div>
          </label>
          {brand.logoUrl && (
            <>
              <div style={logoPreview}><img src={brand.logoUrl} alt="Logo preview" style={{ maxHeight: 80, maxWidth: '100%' }} /></div>
              <button type="button" onClick={onOpenPlacer} style={{ ...secondaryBtn, marginTop: 8, width: '100%', justifyContent: 'center' }} disabled={running} data-testid="open-placer">
                <Move size={14} /> Place logo {brand.custom ? '(custom set)' : '(auto)'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Model picker panel ──────────────────────────────────────────────────────
function ModelPickerPanel({
  catalog, availableModels, strategy, setStrategy, perTier, setPerTier,
  open, setOpen, advancedOpen, setAdvancedOpen, running, resolvedSelection, costEstimate,
}) {
  const strategies = catalog.strategies && catalog.strategies.length ? catalog.strategies : ['recommended', 'cheapest', 'smartest', 'custom'];
  const byId = new Map(catalog.models.map((m) => [m.id, m]));
  const engineMissing = catalog.models.length === 0;

  return (
    <div style={collapsible}>
      <button type="button" onClick={() => setOpen((v) => !v)} style={collapsibleHeader}>
        <Cpu size={16} />
        Models {STRATEGY_LABEL[strategy] ? `· ${STRATEGY_LABEL[strategy]}` : ''}
        {costEstimate.known && (
          <span style={{ ...estChip, marginLeft: 8 }} data-testid="cost-estimate">~${costEstimate.cost.toFixed(3)}</span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 18 }}>{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div style={collapsibleBody}>
          {engineMissing && (
            <p style={{ ...fieldHint, marginBottom: 8 }}>
              Model catalog unavailable (the engine may not be installed). Strategy presets still apply at run time.
            </p>
          )}
          <label style={fieldLabel}>
            Strategy
            <select value={strategy} onChange={(e) => setStrategy(e.target.value)} style={selectStyle} disabled={running}>
              {strategies.map((s) => <option key={s} value={s}>{STRATEGY_LABEL[s] || s}</option>)}
            </select>
            <span style={fieldHint}>{STRATEGY_HINT[strategy] || ''}</span>
          </label>

          {/* Pre-run cost estimate */}
          <div style={estBox}>
            <div>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)' }}>Estimated cost · one run</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>~31k in + 13.5k out across tiers</div>
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
              {costEstimate.known ? `$${costEstimate.cost.toFixed(3)}` : '—'}
            </div>
          </div>

          {/* Advanced per-tier overrides */}
          {strategy === 'custom' && (
            <div style={{ marginTop: 8 }}>
              {!availableModels.length && <p style={fieldHint}>No models reachable with the configured keys.</p>}
              {ALL_TIERS.map((tier) => {
                const info = TIER_INFO[tier] || { label: tier, hint: '' };
                const selId = perTier[tier] || resolvedSelection[tier] || '';
                const sel = byId.get(selId);
                return (
                  <label key={tier} style={fieldLabel}>
                    <span style={{ textTransform: 'capitalize' }}>{info.label} <span style={fieldHint}>— {info.hint}</span></span>
                    <select
                      value={selId}
                      onChange={(e) => setPerTier((p) => ({ ...p, [tier]: e.target.value }))}
                      style={selectStyle}
                      disabled={running || !availableModels.length}
                    >
                      {catalog.defaults[tier] && !availableModels.find((m) => m.id === catalog.defaults[tier]) && (
                        <option value={catalog.defaults[tier]}>{catalog.defaults[tier]} (.env default)</option>
                      )}
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id}>{m.label} · {m.provider} · ${m.inputPer1M}/${m.outputPer1M}/1M</option>
                      ))}
                    </select>
                    {sel && (
                      <span style={fieldHint}>
                        Smart {sel.intelligence}/5 · Value {sel.costEff}/5 — {sel.blurb}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}

          {/* Show the resolved per-tier selection for non-custom strategies */}
          {strategy !== 'custom' && availableModels.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <button type="button" onClick={() => setAdvancedOpen((v) => !v)} style={rawToggleBtn}>
                {advancedOpen ? '− Hide' : '+ Show'} resolved per-tier models
              </button>
              {advancedOpen && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                  {ALL_TIERS.map((tier) => {
                    const m = byId.get(resolvedSelection[tier] || '');
                    return (
                      <div key={tier} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                        <span style={{ textTransform: 'capitalize' }}>{TIER_INFO[tier]?.label || tier}</span>
                        <span>{m ? `${m.label} (${m.provider})` : (resolvedSelection[tier] || '—')}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Visual logo placer (port of LogoPlacer.tsx, plain JS + CRM tokens) ──────
const COVER_BOUNDS = { min: 0.08, max: 0.5, dflt: 0.24 };
const INNER_BOUNDS = { min: 0.06, max: 0.3, dflt: 0.12 };
const COVER_DEFAULT = { x: 0.5, y: 0.3, scale: COVER_BOUNDS.dflt };
const INNER_DEFAULT = { corner: 'top-left', scale: INNER_BOUNDS.dflt };
const PLACER_CORNERS = [
  { key: 'top-left', label: 'Top L' },
  { key: 'top-center', label: 'Top C' },
  { key: 'top-right', label: 'Top R' },
  { key: 'bottom-left', label: 'Bot L' },
  { key: 'bottom-center', label: 'Bot C' },
  { key: 'bottom-right', label: 'Bot R' },
];
const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function cornerPos(corner) {
  const [v, h] = corner.split('-');
  const s = { position: 'absolute' };
  if (v === 'top') s.top = 4; else s.bottom = 4;
  if (h === 'left') s.left = 4;
  else if (h === 'right') s.right = 4;
  else { s.left = '50%'; s.transform = 'translateX(-50%)'; }
  return s;
}

function LogoPlacer({ logoUrl, family, templateName, accent, brandName, value, onSave, onClose }) {
  const insideZones = family === 'banded' ? PLACER_CORNERS.filter((z) => z.key.startsWith('top')) : PLACER_CORNERS;
  const [showCover, setShowCover] = useState(value ? !!value.cover : true);
  const [cover, setCover] = useState(value?.cover || COVER_DEFAULT);
  const [showInner, setShowInner] = useState(!!value?.interior);
  const [inner, setInner] = useState(value?.interior || INNER_DEFAULT);
  const [backing, setBacking] = useState(value?.backing || 'none');
  const plated = backing === 'plate';
  const bareShadow = plated ? undefined : 'drop-shadow(0 2px 9px rgba(0,0,0,.55))';

  const canvasRef = useRef(null);
  const gesture = useRef(null);
  const dragOffset = useRef({ dx: 0, dy: 0 });

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (family === 'banded' && !inner.corner.startsWith('top')) {
      setInner((s) => ({ ...s, corner: s.corner.endsWith('left') ? 'top-left' : s.corner.endsWith('right') ? 'top-right' : 'top-center' }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [family]);

  const norm = (e) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0.5, y: 0.5 };
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
  };
  const startMove = (e) => {
    e.preventDefault();
    const { x, y } = norm(e);
    dragOffset.current = { dx: cover.x - x, dy: cover.y - y };
    gesture.current = 'move';
    canvasRef.current?.setPointerCapture(e.pointerId);
  };
  const startResize = (e) => {
    e.preventDefault();
    e.stopPropagation();
    gesture.current = 'resize';
    canvasRef.current?.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!gesture.current) return;
    const { x, y } = norm(e);
    if (gesture.current === 'move') {
      setCover((c) => ({ ...c, x: clampN(x + dragOffset.current.dx, 0.05, 0.95), y: clampN(y + dragOffset.current.dy, 0.05, 0.95) }));
    } else {
      setCover((c) => ({ ...c, scale: clampN(Math.abs(x - c.x) * 2, COVER_BOUNDS.min, COVER_BOUNDS.max) }));
    }
  };
  const endGesture = (e) => {
    gesture.current = null;
    try { canvasRef.current?.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const save = () => {
    const out = { cover: showCover ? cover : null, interior: showInner ? inner : null, backing };
    onSave(out.cover || out.interior ? out : null);
  };

  const agencyText = (brandName || 'Agency').toUpperCase();

  return (
    <div style={placerOverlay} onClick={onClose}>
      <div style={placerModal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 15 }}>Place your logo</h3>
            <p style={{ ...fieldHint, marginTop: 2 }}>Previews the <strong>{templateName}</strong> template · drag &amp; resize on the cover, then optionally pin a corner mark inside.</p>
          </div>
          <button type="button" onClick={onClose} style={iconBtn} aria-label="Close"><X size={16} /></button>
        </div>

        <div style={placerGrid}>
          {/* Cover canvas */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>Cover</span>
              <label style={{ ...fieldHint, display: 'flex', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={showCover} onChange={(e) => setShowCover(e.target.checked)} /> show logo on cover
              </label>
            </div>
            <div
              ref={canvasRef}
              onPointerMove={onPointerMove}
              onPointerUp={endGesture}
              onPointerCancel={endGesture}
              style={{
                position: 'relative', aspectRatio: '210 / 297', width: '100%', touchAction: 'none', userSelect: 'none',
                overflow: 'hidden', borderRadius: 8, border: '1px solid var(--border-color)',
                background: family === 'editorial'
                  ? 'linear-gradient(to bottom, #78716c, #44403c, #1c1917)'
                  : 'linear-gradient(to bottom, #475569, #0f172a, #000)',
                opacity: showCover ? 1 : 0.4,
              }}
            >
              {family === 'banded' && (
                <div style={{ position: 'absolute', left: '50%', top: '46%', transform: 'translate(-50%,-50%)', width: '70%', aspectRatio: '1 / 1', borderRadius: '50%', background: accent, opacity: 0.82 }} />
              )}
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', justifyContent: 'space-between', padding: '6px 10px', fontSize: 6, letterSpacing: 2, textTransform: 'uppercase', color: 'rgba(255,255,255,0.75)' }}>
                <span style={{ maxWidth: '55%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agencyText}</span>
                <span>2026</span>
              </div>
              <div style={{ position: 'absolute', left: 12, right: 12, bottom: 22 }}>
                <div style={{ height: 9, width: '60%', borderRadius: 2, background: 'rgba(255,255,255,0.9)', marginBottom: 4 }} />
                <div style={{ height: 9, width: '40%', borderRadius: 2, background: 'rgba(255,255,255,0.9)' }} />
              </div>
              {showCover && (
                <div
                  onPointerDown={startMove}
                  style={{
                    position: 'absolute', left: `${cover.x * 100}%`, top: `${cover.y * 100}%`, width: `${cover.scale * 100}%`,
                    transform: 'translate(-50%, -50%)', cursor: 'grab', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    borderRadius: 2, padding: plated ? 4 : 0, background: plated ? 'rgba(255,255,255,0.9)' : 'transparent',
                    boxShadow: plated ? '0 2px 8px rgba(0,0,0,0.3)' : 'none',
                  }}
                >
                  <img src={logoUrl} alt="logo" style={{ pointerEvents: 'none', display: 'block', width: '100%', height: 'auto', objectFit: 'contain', filter: bareShadow }} />
                  <span onPointerDown={startResize} title="Drag to resize" style={{ position: 'absolute', bottom: -7, right: -7, height: 14, width: 14, cursor: 'nwse-resize', borderRadius: '50%', border: '2px solid #fff', background: 'var(--primary-color, var(--accent-color))' }} />
                </div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <span style={{ width: 36, fontSize: 10, color: 'var(--text-secondary)' }}>Size</span>
              <input type="range" min={COVER_BOUNDS.min} max={COVER_BOUNDS.max} step={0.01} value={cover.scale} disabled={!showCover} onChange={(e) => setCover((c) => ({ ...c, scale: Number(e.target.value) }))} style={{ flex: 1 }} />
              <span style={{ width: 32, textAlign: 'right', fontSize: 10, color: 'var(--text-secondary)' }}>{Math.round(cover.scale * 100)}%</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <span style={{ width: 36, fontSize: 10, color: 'var(--text-secondary)' }}>Backing</span>
              <div style={{ display: 'flex', overflow: 'hidden', borderRadius: 6, border: '1px solid var(--border-color)' }}>
                {['none', 'plate'].map((b) => (
                  <button key={b} type="button" onClick={() => setBacking(b)} style={{ padding: '4px 8px', fontSize: 10, border: 'none', cursor: 'pointer', background: backing === b ? 'var(--primary-color, var(--accent-color))' : 'var(--surface-color)', color: backing === b ? '#fff' : 'var(--text-secondary)' }}>
                    {b === 'none' ? 'As uploaded' : 'White plate'}
                  </button>
                ))}
              </div>
            </div>
            <p style={{ ...fieldHint, marginTop: 6 }}>
              {plated ? 'A white box sits behind the logo — helps a light/thin logo stay legible on busy photos.' : 'Logo used exactly as uploaded — transparency kept, no box (a soft shadow keeps it readable).'}
            </p>
          </div>

          {/* Inside pages */}
          <div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, fontWeight: 600, marginBottom: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={showInner} onChange={(e) => setShowInner(e.target.checked)} /> Also place a mark on inside pages
            </label>
            <p style={{ ...fieldHint, marginBottom: 8 }}>The inside mark snaps to a corner and the engine reserves that space, so content always reflows cleanly.</p>
            <div style={{ opacity: showInner ? 1 : 0.4, pointerEvents: showInner ? 'auto' : 'none' }}>
              <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                <div style={{ position: 'relative', aspectRatio: '210 / 297', width: 120, flexShrink: 0, overflow: 'hidden', borderRadius: 6, border: '1px solid var(--border-color)', background: '#fff' }}>
                  <div style={{ position: 'absolute', left: 12, right: 12, top: 16 }}>
                    {['85%', '70%', '92%', '60%', '78%'].map((w, i) => (
                      <div key={i} style={{ height: 4, borderRadius: 2, background: '#cbd5e1', width: w, marginBottom: 5 }} />
                    ))}
                  </div>
                  {insideZones.map((cn) => {
                    const selected = inner.corner === cn.key;
                    return (
                      <button key={cn.key} type="button" onClick={() => setInner((s) => ({ ...s, corner: cn.key }))} title={cn.key}
                        style={{ ...cornerPos(cn.key), height: 20, width: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 3, fontSize: 8, border: 'none', cursor: 'pointer', background: selected ? 'var(--primary-color, var(--accent-color))' : '#e2e8f0', color: selected ? '#fff' : '#64748b' }}>
                        {cn.label.split(' ')[1] || cn.label}
                      </button>
                    );
                  })}
                  <div style={{ ...cornerPos(inner.corner), pointerEvents: 'none', width: `${inner.scale * 100}%`, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 2, padding: plated ? 2 : 0, background: plated ? 'rgba(255,255,255,0.9)' : 'transparent' }}>
                    <img src={logoUrl} alt="" style={{ display: 'block', width: '100%', height: 'auto', objectFit: 'contain', filter: bareShadow }} />
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Position{family === 'banded' ? ' · header (L / C / R)' : ''}</span>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 4 }}>
                    {insideZones.map((cn) => (
                      <button key={cn.key} type="button" onClick={() => setInner((s) => ({ ...s, corner: cn.key }))}
                        style={{ borderRadius: 6, padding: '4px 6px', fontSize: 10, cursor: 'pointer', border: inner.corner === cn.key ? '1px solid var(--primary-color, var(--accent-color))' : '1px solid var(--border-color)', background: inner.corner === cn.key ? 'var(--subtle-bg-3)' : 'var(--surface-color)', color: 'var(--text-primary)' }}>
                        {cn.label}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
                    <span style={{ width: 36, fontSize: 10, color: 'var(--text-secondary)' }}>Size</span>
                    <input type="range" min={INNER_BOUNDS.min} max={INNER_BOUNDS.max} step={0.01} value={inner.scale} onChange={(e) => setInner((s) => ({ ...s, scale: Number(e.target.value) }))} style={{ flex: 1 }} />
                    <span style={{ width: 32, textAlign: 'right', fontSize: 10, color: 'var(--text-secondary)' }}>{Math.round(inner.scale * 100)}%</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: 12, marginTop: 16 }}>
          <button type="button" onClick={() => onSave(null)} style={{ ...chipBtn, textDecoration: 'underline' }} title="Clear custom placement — automatic placement takes over">Reset to automatic</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={onClose} style={secondaryBtn}>Cancel</button>
            <button type="button" onClick={save} style={{ ...primaryBtn, width: 'auto' }} data-testid="placer-save">Save placement</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────
function AgentCard({ agent }) {
  const indented = !!agent.parentKey;
  const statusColor =
    agent.status === 'done' ? '#22863a' : agent.status === 'working' ? 'var(--primary-color, var(--accent-color))' : 'var(--text-secondary)';
  return (
    <div style={{ ...agentCardStyle, marginLeft: indented ? 18 : 0, borderLeft: indented ? '2px solid var(--border-color)' : agentCardStyle.border }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
        <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.name}</span>
        {agent.tier && <span style={tierBadge}>{agent.tier}</span>}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: statusColor, fontWeight: 600, textTransform: 'uppercase' }}>{agent.status}</span>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 4, fontSize: 11, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
        <span>{agent.inputTokens.toLocaleString()} in</span>
        <span>{agent.outputTokens.toLocaleString()} out</span>
        <span>{agent.calls} call{agent.calls === 1 ? '' : 's'}</span>
        {agent.costUsd > 0 && <span style={{ marginLeft: 'auto' }}>${agent.costUsd.toFixed(4)}</span>}
      </div>
    </div>
  );
}

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
    <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: bg, color: fg, textTransform: 'uppercase', letterSpacing: 0.5 }}>{status}</span>
  );
}

// ─── Styles (CSS-var-driven, matches ItineraryTemplates.jsx) ──────────────
const pageHeaderRow = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 16 };
const pageTitle = { display: 'flex', alignItems: 'center', gap: 10, margin: 0 };
const pageSubtitle = { color: 'var(--text-secondary)', marginTop: 4, maxWidth: 720 };
const tabBar = { display: 'flex', gap: 4, background: 'var(--subtle-bg)', borderRadius: 8, padding: 4 };
const tabBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 6, fontWeight: 600, fontSize: 13, background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer' };
const activeTabBtn = { ...tabBtn, background: 'var(--surface-color)', color: 'var(--primary-color, var(--accent-color))', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' };
const twoColLayout = { display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 480px), 1fr))', alignItems: 'flex-start' };
const panel = { background: 'var(--surface-color)', padding: 16, borderRadius: 8, border: '1px solid var(--border-color)' };
const panelTitle = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 16, margin: '0 0 12px 0' };
const fieldLabel = { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12, fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 };
const fieldHint = { fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, fontWeight: 400 };
const fieldHintRight = { fontSize: 11, color: 'var(--text-secondary)', textAlign: 'right' };
const inputStyle = { padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--bg-color)', color: 'var(--text-primary)', fontSize: 13, width: '100%', boxSizing: 'border-box' };
const selectStyle = { ...inputStyle, background: 'var(--surface-color)' };
const staticField = { ...inputStyle, background: 'var(--subtle-bg)', cursor: 'default', display: 'flex', alignItems: 'center', fontWeight: 600 };
const inlineCode = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, padding: '1px 5px', borderRadius: 3, background: 'var(--subtle-bg)', color: 'var(--text-primary)' };
const sampleRow = { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', marginTop: -4, marginBottom: 12 };
const chipBtn = { fontSize: 11, padding: '3px 8px', borderRadius: 12, border: '1px solid var(--border-color)', background: 'var(--bg-color)', color: 'var(--text-secondary)', cursor: 'pointer' };
const collapsible = { border: '1px solid var(--border-color)', borderRadius: 6, marginBottom: 12 };
const collapsibleHeader = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 12px', border: 'none', background: 'var(--subtle-bg)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer', borderRadius: 6 };
const collapsibleBody = { padding: 12 };
const logoPreview = { padding: 12, background: 'var(--subtle-bg)', borderRadius: 6, textAlign: 'center' };
const primaryBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 6, fontWeight: 600, fontSize: 14, background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', cursor: 'pointer', width: '100%', justifyContent: 'center' };
const disabledPrimaryBtn = { ...primaryBtn, opacity: 0.6, cursor: 'not-allowed' };
const secondaryBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 6, fontWeight: 600, fontSize: 12, background: 'var(--surface-color)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', cursor: 'pointer' };
const iconBtn = { padding: 4, borderRadius: 4, background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer' };
const emptyStyle = { padding: 32, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 };
const runHeaderRow = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 10 };
const liveCostBadge = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 12, background: 'var(--subtle-bg-3)', color: 'var(--text-primary)', fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums' };
const agentGrid = { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 };
const agentCardStyle = { padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--bg-color)' };
const tierBadge = { padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: 600, background: 'var(--subtle-bg-3)', color: 'var(--primary-color, var(--accent-color))', textTransform: 'uppercase', letterSpacing: 0.5 };
const rawToggleBtn = { background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', padding: '4px 0', textAlign: 'left' };
const traceBox = { background: 'var(--bg-color)', border: '1px solid var(--border-color)', borderRadius: 6, padding: 8, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, maxHeight: 280, overflowY: 'auto', marginBottom: 8 };
const traceLine = { display: 'flex', gap: 6, padding: '2px 4px', borderBottom: '1px dashed var(--border-color)', alignItems: 'baseline' };
const traceLineMuted = { ...traceLine, color: 'var(--text-secondary)', justifyContent: 'center', borderBottom: 'none', padding: 16 };
const traceType = { color: 'var(--primary-color, var(--accent-color))', minWidth: 130, fontWeight: 600 };
const traceAgent = { color: 'var(--text-primary)', minWidth: 80 };
const traceData = { color: 'var(--text-secondary)', wordBreak: 'break-word', flex: 1 };
const errorBox = { marginTop: 8, padding: 10, borderRadius: 6, background: 'rgba(176,0,0,0.08)', border: '1px solid rgba(176,0,0,0.25)', color: '#b00', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 };
const resultBox = { marginTop: 12, padding: 10, borderRadius: 6, background: 'var(--subtle-bg)', border: '1px solid var(--border-color)' };
const resultHeader = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' };
const costBadge = { padding: '2px 8px', borderRadius: 12, background: 'var(--subtle-bg-3)', color: 'var(--text-primary)', fontSize: 11, fontWeight: 600 };
const estChip = { padding: '1px 8px', borderRadius: 12, background: 'var(--subtle-bg-3)', color: 'var(--text-primary)', fontSize: 11, fontWeight: 600, fontVariantNumeric: 'tabular-nums' };
const estBox = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--subtle-bg)', marginBottom: 8 };
const pdfFrame = { width: '100%', height: 480, border: '1px solid var(--border-color)', borderRadius: 6, background: 'white' };
const tableStyle = { width: '100%', borderCollapse: 'collapse' };
const th = { textAlign: 'left', padding: '10px 12px', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)', background: 'var(--subtle-bg)' };
const td = { padding: '10px 12px', fontSize: 14, color: 'var(--text-primary)', verticalAlign: 'top', borderBottom: '1px solid var(--border-color)' };
const brandBadge = { padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: 'var(--subtle-bg-3)', color: 'var(--primary-color, var(--accent-color))', textTransform: 'uppercase', letterSpacing: 0.5 };
const ellipsis2 = { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', textOverflow: 'ellipsis' };
const placerOverlay = { position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.7)', padding: 16 };
const placerModal = { maxHeight: '92vh', width: '100%', maxWidth: 760, overflowY: 'auto', borderRadius: 14, border: '1px solid var(--border-color)', background: 'var(--surface-color)', padding: 20 };
const placerGrid = { display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', marginTop: 12 };
