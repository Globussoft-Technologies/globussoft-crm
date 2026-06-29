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
// the proxy-friendly `/api/brochure-assets/...` form. S3/CloudFront URLs pass
// through unchanged. The backend mounts the static dir at both local paths but
// Vite's dev proxy only forwards /api/*.
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
// Per-tier token totals, CALIBRATED to a real "recommended" run on a rich 12-day brief
// (captured via the engine's per-call usage events). The reasoning tier runs the Studio
// Director CEO across ~3 looped delegation calls AND the Brochure Composer, so its total
// is the SUM of both. The balanced tier is omitted — no travel agent runs on it. This is
// representative of a full brief; a sparse brief costs proportionally less. The estimate
// multiplies the result by the engine's BILLING_MARKUP so it shows the BILLED amount.
const TIER_TOKENS = {
  reasoning: { input: 22900, output: 4700 }, // CEO (~3 calls) + brochure composer
  fast: { input: 700, output: 2400 }, // destination researcher
  writing: { input: 850, output: 1400 }, // copywriter
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
  // recommended — reasoning tier (Studio Director CEO + Brochure Composer) pinned to
  // gpt-5.4-mini, else the computed balanced pick. Mirrors crm-bridge.ts strategyAssignment.
  const reasoningPick = avail.find((m) => m.id === 'gpt-5.4-mini')?.id ?? balanced.id;
  return { reasoning: reasoningPick, balanced: balanced.id, fast: cheapest.id, writing: balanced.id };
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
    // accentMode 'auto' (default) → DON'T send a colour; the AI picks one inferred
    // from the destination (engine composer emits palette.accent). 'manual' → send
    // the hand-picked `accent` below, which overrides the AI choice.
    name: '', tagline: '', logoUrl: '', accentMode: 'auto', accent: '#122647',
    contact: [], socials: [], qrUrl: '', custom: null,
    // Unified image pool — every uploaded image lands here first, then the user
    // selects which ones go on the front cover and/or inside pages.
    imagePool: [],
    // Additional front-cover logos beyond the primary — each { url, x, y, scale }.
    coverLogos: [],
    // Interior logo band — { band:'header'|'bottom', scale, items:[{url,x}] } | null.
    interiorLogos: null,
  });
  const [coverPlacerOpen, setCoverPlacerOpen] = useState(false); // front-cover logo placer
  const [bandOpen, setBandOpen] = useState(false); // interior logo band placer open?
  // Every uploaded image is available for the front cover and the interior band.
  const logoPool = brand.imagePool || [];
  // Saved brand profiles (server-persisted, tenant-scoped — shared across devices/team)
  const [profiles, setProfiles] = useState([]);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileName, setProfileName] = useState(''); // current slot name — set on load so "Save current" UPDATES it
  // Model catalog + selection
  const [catalog, setCatalog] = useState({ tiers: [], strategies: [], defaults: {}, markup: 1.5, models: [] });
  const [strategy, setStrategy] = useState('recommended');
  const [perTier, setPerTier] = useState({}); // advanced overrides { reasoning: id, ... }
  const [modelOpen, setModelOpen] = useState(false);
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
            markup: Number(data.markup) > 0 ? Number(data.markup) : 1.5, // billing markup → estimate shows BILLED amount
            models: data.models,
          });
        }
      } catch (e) {
        // Engine not installed → 503. The picker degrades to strategy presets.
        console.warn('[brochures] model catalog unavailable', e);
      }
    })();
    loadHistory();
    loadProfiles();
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

  // ─── Saved brand profiles ──────────────────────────────────────────────
  const loadProfiles = useCallback(async () => {
    try {
      const data = await fetchApi('/api/travel/brochures/brand-profiles');
      if (data && Array.isArray(data.profiles)) setProfiles(data.profiles);
    } catch (e) {
      console.warn('[brochures] profiles load failed', e);
    }
  }, []);

  const saveProfile = useCallback(async (name) => {
    const nm = (name || '').trim();
    if (!nm) { notify.error('Give the brand profile a name.'); return; }
    setProfileBusy(true);
    try {
      // Persist the brand-kit FORM snapshot so it round-trips straight back into the UI.
      const form = {
        name: brand.name || '', tagline: brand.tagline || '', accentMode: brand.accentMode || 'auto',
        accent: brand.accent || '#122647', logoUrl: brand.logoUrl || '', contact: brand.contact || [],
        socials: brand.socials || [], qrUrl: brand.qrUrl || '', custom: brand.custom || null,
        imagePool: brand.imagePool || [],
        coverLogos: brand.coverLogos || [],
        interiorLogos: brand.interiorLogos || null,
      };
      await fetchApi('/api/travel/brochures/brand-profiles', {
        method: 'POST',
        body: JSON.stringify({ name: nm, brand: form }),
      });
      notify.success(`Brand profile “${nm}” saved.`);
      await loadProfiles();
    } catch (err) {
      notify.error(err?.message || 'Failed to save brand profile.');
    } finally {
      setProfileBusy(false);
    }
  }, [brand, notify, loadProfiles]);

  const applyProfile = useCallback((p) => {
    const f = p?.brand || {};
    // Back-compat: older profiles stored only logoUrl + coverLogos + interiorLogos.
    // Merge any explicit pool with all URLs still referenced by cover/inside placements
    // so nothing disappears after load.
    const explicitPool = Array.isArray(f.imagePool) ? f.imagePool : [];
    const legacyPool = [
      f.logoUrl,
      ...(Array.isArray(f.coverLogos) ? f.coverLogos.map((l) => l.url) : []),
      ...(f.interiorLogos?.items ? f.interiorLogos.items.map((it) => it.url) : []),
    ].filter(Boolean);
    const imagePool = Array.from(new Set([...explicitPool, ...legacyPool])).filter(Boolean);
    setBrand((b) => ({
      ...b,
      name: f.name || '', tagline: f.tagline || '', accentMode: f.accentMode || 'auto',
      accent: f.accent || '#122647', logoUrl: f.logoUrl || '', contact: Array.isArray(f.contact) ? f.contact : [],
      socials: Array.isArray(f.socials) ? f.socials : [], qrUrl: f.qrUrl || '', custom: f.custom || null,
      imagePool,
      coverLogos: Array.isArray(f.coverLogos) ? f.coverLogos : [],
      interiorLogos: f.interiorLogos && Array.isArray(f.interiorLogos.items) ? f.interiorLogos : null,
    }));
    setProfileName(p?.name || ''); // prefill the slot name so "Save current" overwrites this profile
    notify.info(`Loaded “${p?.name || 'profile'}”.`);
  }, [notify]);

  const deleteProfile = useCallback(async (id) => {
    try {
      await fetchApi(`/api/travel/brochures/brand-profiles/${id}`, { method: 'DELETE' });
      setProfiles((list) => list.filter((p) => p.id !== id));
    } catch (err) {
      notify.error(err?.message || 'Failed to delete profile.');
    }
  }, [notify]);

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
    let raw = 0;
    let known = catalog.models.length > 0;
    for (const tier of Object.keys(TIER_TOKENS)) {
      const m = byId.get(resolvedSelection[tier] || '');
      if (!m) { known = false; continue; }
      const t = TIER_TOKENS[tier];
      raw += (t.input / 1e6) * m.inputPer1M + (t.output / 1e6) * m.outputPer1M;
    }
    // Show the BILLED amount (raw provider cost × billing markup) so the estimate lands
    // on the actual bill, not the un-marked-up provider cost.
    const markup = Number(catalog.markup) > 0 ? Number(catalog.markup) : 1.5;
    return { cost: raw * markup, known };
  }, [catalog.models, catalog.markup, resolvedSelection]);

  // ─── Unified image upload ──────────────────────────────────────────────
  // One upload button feeds every logo use (front cover + inside pages). Files
  // are uploaded to S3 (or base64-fallback when S3 is disabled) via the backend;
  // the first returned URL becomes the primary logo and all URLs join the pool.
  const onUploadImages = useCallback(async (files) => {
    const list = files instanceof FileList || Array.isArray(files) ? Array.from(files) : (files ? [files] : []);
    const valid = [];
    for (const file of list) {
      if (file.size > 10 * 1024 * 1024) { notify.error(`"${file.name}" too large — max 10MB.`); continue; }
      if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) { notify.error(`"${file.name}" must be PNG, JPEG, WebP, or GIF.`); continue; }
      valid.push(file);
    }
    if (!valid.length) return;
    const formData = new FormData();
    valid.forEach((f) => formData.append('images', f));
    try {
      const data = await fetchApi('/api/travel/brochures/brand-images/upload', { method: 'POST', body: formData });
      const urls = Array.isArray(data?.urls) ? data.urls : [];
      if (!urls.length) { notify.error('No images were uploaded.'); return; }
      setBrand((b) => {
        const imagePool = [...(b.imagePool || []), ...urls];
        const next = { ...b, imagePool };
        if (!b.logoUrl) next.logoUrl = urls[0];
        return next;
      });
    } catch (_err) {
      notify.error('Failed to upload brand images.');
    }
  }, [notify]);

  const removeImage = useCallback((url) => {
    // Update UI state immediately; fire-and-forget the remote delete for S3 URLs.
    setBrand((b) => {
      const imagePool = (b.imagePool || []).filter((u) => u !== url);
      const wasPrimary = b.logoUrl === url;
      const logoUrl = wasPrimary ? (imagePool[0] || '') : b.logoUrl;
      // Drop the removed URL from cover logos and the interior band.
      let coverLogos = (b.coverLogos || []).filter((l) => l.url !== url);
      // If the new primary was previously a cover logo, remove it from coverLogos
      // (the primary is shown on the front cover automatically).
      if (wasPrimary && logoUrl) {
        coverLogos = coverLogos.filter((l) => l.url !== logoUrl);
      }
      let interiorLogos = b.interiorLogos;
      if (interiorLogos?.items?.some((it) => it.url === url)) {
        const items = interiorLogos.items.filter((it) => it.url !== url);
        interiorLogos = items.length ? { ...interiorLogos, items } : null;
      }
      // Clear custom placement only when the primary itself was removed.
      const custom = wasPrimary ? null : b.custom;
      return { ...b, imagePool, logoUrl, coverLogos, interiorLogos, custom };
    });
    // Ask the backend to delete S3-hosted images; data-URIs / external URLs are
    // ignored by the endpoint, so the call is safe for any URL shape.
    if (url && !url.startsWith('data:')) {
      fetchApi('/api/travel/brochures/brand-images/file', {
        method: 'DELETE',
        body: JSON.stringify({ url }),
      }).catch((err) => {
        console.warn('[brochures] failed to delete remote image', err);
      });
    }
  }, []);

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
    // Auto mode: omit colours entirely so the AI's destination-inferred accent wins.
    // Manual mode: send the picked hex (overrides the AI choice in the engine).
    if (brand.accentMode === 'manual' && /^#[0-9a-f]{6}$/i.test(brand.accent || '')) brandPayload.colors = { accent: brand.accent };
    const contacts = (brand.contact || []).map((c) => String(c).trim()).filter(Boolean);
    if (contacts.length) brandPayload.contact = contacts;
    const socials = (brand.socials || []).map((s) => String(s).trim()).filter(Boolean);
    if (socials.length) brandPayload.socials = socials;
    // QR link — backend re-validates (http(s) only); the engine encodes it into the QR.
    if (brand.qrUrl?.trim() && /^https?:\/\//i.test(brand.qrUrl.trim())) brandPayload.qrUrl = brand.qrUrl.trim();
    if (brand.logoUrl && brand.custom) brandPayload.custom = brand.custom;
    // Additional cover logos (backend re-validates each + clamps placement).
    const coverLogos = (brand.coverLogos || []).filter((l) => l && l.url);
    if (coverLogos.length) brandPayload.coverLogos = coverLogos.map((l) => ({ url: l.url, x: l.x, y: l.y, scale: l.scale }));
    // Interior logo band (backend re-validates each item + clamps).
    if (brand.interiorLogos?.items?.length) brandPayload.interiorLogos = {
      band: brand.interiorLogos.band, scale: brand.interiorLogos.scale,
      items: brand.interiorLogos.items.map((it) => ({ url: it.url, x: it.x })),
    };

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

  // ─── Stop a running generation (hit Generate by mistake / changed your mind) ──
  // Detach the SSE + free the UI immediately, then ask the backend to kill the
  // engine subprocess. The UI never waits on the network — Stop is instant.
  const handleStop = useCallback(async () => {
    const runId = activeRunId;
    if (esRef.current) {
      try { esRef.current.close(); } catch { /* ignore */ }
      esRef.current = null;
    }
    setRunning(false);
    setRunError(null);
    if (runId) {
      try {
        await fetchApi(`/api/travel/brochures/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
        notify.info('Generation stopped.');
      } catch {
        notify.info('Generation stopped (the engine may finish in the background).');
      }
      loadHistory();
    }
  }, [activeRunId, notify, loadHistory]);

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
        // Local static URLs need same-origin credentials; S3/CloudFront public URLs
        // use CORS without credentials to avoid preflight/credential mismatches.
        const isAbsolute = /^https?:\/\//i.test(result.pdfUrl);
        const resp = await fetch(result.pdfUrl, {
          mode: isAbsolute ? 'cors' : 'same-origin',
          credentials: isAbsolute ? 'omit' : 'same-origin',
        });
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
              onUploadImages={onUploadImages}
              onRemoveImage={removeImage}
              onOpenCoverPlacer={() => setCoverPlacerOpen(true)}
              onOpenBand={() => setBandOpen(true)}
              hasLogos={logoPool.length > 0}
              profiles={profiles}
              profileBusy={profileBusy}
              profileName={profileName}
              setProfileName={setProfileName}
              onSaveProfile={saveProfile}
              onApplyProfile={applyProfile}
              onDeleteProfile={deleteProfile}
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
              running={running}
              resolvedSelection={resolvedSelection}
              costEstimate={costEstimate}
            />

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="submit"
                disabled={running || !goal.trim()}
                style={running ? disabledPrimaryBtn : primaryBtn}
                data-testid="generate-brochure"
              >
                {running ? <><Loader size={16} className="anim-spin" /> Generating…</> : <><Sparkles size={16} /> Generate brochure</>}
              </button>
              {running && (
                <button
                  type="button"
                  onClick={handleStop}
                  data-testid="stop-brochure"
                  title="Stop generation"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 18px', height: 44,
                    borderRadius: 10, border: '1px solid #e06a5a', background: 'transparent',
                    color: '#e06a5a', fontWeight: 700, fontSize: 14, cursor: 'pointer', flex: '0 0 auto',
                  }}
                >
                  <X size={16} /> Stop
                </button>
              )}
            </div>
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

      {/* Front-cover logo placer — template preview + free placement + size. */}
      {coverPlacerOpen && (
        <CoverLogoPlacer
          pool={logoPool}
          value={brand.coverLogos}
          logoUrl={brand.logoUrl}
          custom={brand.custom}
          family={placerFamily}
          templateName={styleKey || (placerFamily === 'editorial' ? 'editorial-sakura' : 'tmc-press')}
          accent={brand.accent}
          brandName={brand.name}
          onSave={(v) => { setBrand((b) => ({ ...b, logoUrl: v.logoUrl, custom: v.custom, coverLogos: v.coverLogos })); setCoverPlacerOpen(false); }}
          onClose={() => setCoverPlacerOpen(false)}
        />
      )}

      {/* Interior logo band placer (pages after the cover) */}
      {bandOpen && (
        <InteriorBandPlacer
          pool={logoPool}
          value={brand.interiorLogos}
          family={placerFamily}
          onSave={(v) => { setBrand((b) => ({ ...b, interiorLogos: v })); setBandOpen(false); }}
          onClose={() => setBandOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Brand kit panel ────────────────────────────────────────────────────────
function BrandKitPanel({ brand, setBrand, open, setOpen, running, fileInputRef, onUploadImages, onRemoveImage, onOpenCoverPlacer, onOpenBand, hasLogos = false, profiles = [], profileBusy = false, profileName = '', setProfileName, onSaveProfile, onApplyProfile, onDeleteProfile }) {
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
          {/* Saved brand profiles — server-persisted, shared across the agency's team */}
          <div style={fieldLabel}>
            <span>Saved brand profiles <span style={fieldHint}>(reuse your logo, accent, contacts & QR)</span></span>
            {profiles.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '4px 0 6px' }}>
                {profiles.map((p) => (
                  <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, border: '1px solid var(--border-color, #333)', borderRadius: 8, overflow: 'hidden' }}>
                    <button type="button" onClick={() => onApplyProfile?.(p)} disabled={running} title={`Load “${p.name}”`} style={{ background: 'transparent', border: 'none', color: 'var(--text-primary, #eee)', padding: '5px 9px', fontSize: 12, cursor: 'pointer', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.name}
                    </button>
                    <button type="button" onClick={() => onDeleteProfile?.(p.id)} disabled={running} aria-label={`Delete ${p.name}`} title="Delete" style={{ background: 'transparent', border: 'none', color: '#e06a5a', padding: '5px 7px', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="text"
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                placeholder="Profile name (e.g. Sakura Trails)"
                style={inputStyle}
                disabled={running || profileBusy}
                data-testid="profile-name"
              />
              <button
                type="button"
                onClick={() => { onSaveProfile?.(profileName); }}
                style={chipBtn}
                disabled={running || profileBusy || !profileName.trim()}
                data-testid="save-profile"
                title="Saving with an existing profile's name overwrites it"
              >
                {profileBusy
                  ? 'Saving…'
                  : profiles.some((p) => p.name.toLowerCase() === profileName.trim().toLowerCase())
                    ? 'Update'
                    : 'Save current'}
              </button>
            </div>
          </div>

          <label style={fieldLabel}>
            Agency name
            <input type="text" value={brand.name} onChange={(e) => setBrand((b) => ({ ...b, name: e.target.value }))} placeholder="Globus Travels" style={inputStyle} disabled={running} />
          </label>
          <label style={fieldLabel}>
            Tagline
            <input type="text" value={brand.tagline} onChange={(e) => setBrand((b) => ({ ...b, tagline: e.target.value }))} placeholder="Crafted journeys, since 1998" style={inputStyle} disabled={running} />
          </label>
          <div style={fieldLabel}>
            <span>Accent colour</span>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 2 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}>
                <input type="radio" name="accentMode" checked={(brand.accentMode || 'auto') === 'auto'} onChange={() => setBrand((b) => ({ ...b, accentMode: 'auto' }))} disabled={running} />
                Auto <span style={fieldHint}>(AI picks by destination)</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}>
                <input type="radio" name="accentMode" checked={brand.accentMode === 'manual'} onChange={() => setBrand((b) => ({ ...b, accentMode: 'manual' }))} disabled={running} />
                Manual
              </label>
              {brand.accentMode === 'manual' && (
                <input type="color" value={brand.accent} onChange={(e) => setBrand((b) => ({ ...b, accent: e.target.value }))} style={{ ...inputStyle, padding: 2, height: 30, width: 48, marginLeft: 'auto' }} disabled={running} aria-label="Accent colour" />
              )}
            </div>
          </div>

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
            QR link <span style={fieldHint}>(any URL — booking page, website; shown as a scannable QR)</span>
            <input type="url" value={brand.qrUrl} onChange={(e) => setBrand((b) => ({ ...b, qrUrl: e.target.value }))} placeholder="https://book.sakuratrails.in" style={inputStyle} disabled={running} />
          </label>

          {/* Unified image upload — every uploaded image lands in the pool first. */}
          <div style={fieldLabel}>
            <span>Upload images <span style={fieldHint}>(PNG / JPEG / WebP / GIF · ≤10MB each · upload as many as you need)</span></span>
            <input ref={fileInputRef} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => { onUploadImages(e.target.files); e.target.value = ''; }} style={{ flex: 1 }} disabled={running} />
            {(brand.imagePool || []).length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {(brand.imagePool || []).map((url, i) => (
                  <div key={url} style={{ position: 'relative', border: '1px solid var(--border-color)', borderRadius: 8, padding: '8px 6px 6px', background: 'var(--surface-color)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, width: 86 }}>
                    <img src={url} alt="" style={{ maxHeight: 38, maxWidth: 72, objectFit: 'contain' }} />
                    <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Image {i + 1}</span>
                    <button type="button" onClick={() => onRemoveImage(url)} aria-label="Remove image" title="Remove" style={{ position: 'absolute', top: -7, right: -7, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: 18, width: 18, borderRadius: '50%', border: '1px solid var(--border-color)', background: 'var(--surface-color)', color: '#e06a5a', cursor: 'pointer', padding: 0 }} disabled={running}><X size={11} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Front cover — opens the cover preview placer. */}
          <div style={fieldLabel}>
            <span>Front cover <span style={fieldHint}>(place logos freely on the cover preview)</span></span>
            <button
              type="button"
              onClick={onOpenCoverPlacer}
              style={{ ...secondaryBtn, width: '100%', justifyContent: 'center' }}
              disabled={running || !hasLogos}
              data-testid="open-cover-placer"
              title={hasLogos ? '' : 'Upload images first'}
            >
              <Move size={14} /> {brand.logoUrl || brand.coverLogos?.length ? 'Edit front-cover logos' : 'Add logos to front cover'}
            </button>
          </div>

          {/* Interior logo band — logos on pages after the cover */}
          <div style={fieldLabel}>
            <span>Logos on inside pages <span style={fieldHint}>(pick from your logos · header or bottom band · drag to place)</span></span>
            <button
              type="button"
              onClick={onOpenBand}
              style={{ ...secondaryBtn, marginTop: 6, width: '100%', justifyContent: 'center' }}
              disabled={running || !hasLogos}
              data-testid="open-band"
              title={hasLogos ? '' : 'Upload a logo or cover logos first'}
            >
              <Move size={14} /> {brand.interiorLogos?.items?.length
                ? `Inside-page logos (${brand.interiorLogos.items.length} · ${brand.interiorLogos.band === 'bottom' ? 'bottom' : 'header'})`
                : 'Add logos to inside pages'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Model picker panel ──────────────────────────────────────────────────────
function ModelPickerPanel({
  catalog, availableModels, strategy, setStrategy, perTier, setPerTier,
  open, setOpen, running, resolvedSelection, costEstimate,
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

          {/* Resolved per-tier models for the presets — always shown, read-only, in the
              same per-tier layout as Custom, so you can see exactly what Recommended /
              Cheapest / Smartest picked for each tier (these are auto-chosen, not editable). */}
          {strategy !== 'custom' && availableModels.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {ALL_TIERS.map((tier) => {
                const info = TIER_INFO[tier] || { label: tier, hint: '' };
                const m = byId.get(resolvedSelection[tier] || '');
                return (
                  <div key={tier} style={fieldLabel}>
                    <span style={{ textTransform: 'capitalize' }}>{info.label} <span style={fieldHint}>— {info.hint}</span></span>
                    <div style={staticField} data-testid={`resolved-${tier}`}>
                      {m ? `${m.label} · ${m.provider} · $${m.inputPer1M}/$${m.outputPer1M}/1M` : (resolvedSelection[tier] || '—')}
                    </div>
                    {m && (
                      <span style={fieldHint}>
                        Smart {m.intelligence}/5 · Value {m.costEff}/5 — {m.blurb}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Logo placer constants (shared by cover + interior placers) ─────────────
const COVER_BOUNDS = { min: 0.08, max: 0.5, dflt: 0.24 };
const INNER_BOUNDS = { min: 0.06, max: 0.3, dflt: 0.12 };
const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function CoverLogoPlacer({ pool, value, logoUrl, custom, family, templateName, accent, brandName, onSave, onClose }) {
  const [items, setItems] = useState(() => {
    const arr = [];
    if (logoUrl && custom?.cover) {
      arr.push({ url: logoUrl, ...custom.cover, backing: custom.backing || 'none' });
    }
    if (Array.isArray(value)) {
      value.forEach((l) => arr.push({ url: l.url, x: l.x, y: l.y, scale: l.scale, backing: 'none' }));
    }
    return arr;
  });
  const [activeUrl, setActiveUrl] = useState(() => {
    const arr = [];
    if (logoUrl && custom?.cover) arr.push(logoUrl);
    if (Array.isArray(value)) arr.push(...value.map((l) => l.url));
    return arr[0] || null;
  });

  const canvasRef = useRef(null);
  const gesture = useRef(null);
  const dragOffset = useRef({ dx: 0, dy: 0 });

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const norm = (e) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0.5, y: 0.5 };
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
  };

  const activeItem = items.find((it) => it.url === activeUrl);

  const toggle = (url) => {
    setItems((arr) => {
      const has = arr.some((it) => it.url === url);
      if (has) {
        const next = arr.filter((it) => it.url !== url);
        if (activeUrl === url) setActiveUrl(next[0]?.url || null);
        return next;
      }
      if (arr.length >= 8) return arr;
      const x = arr.length === 0 ? 0.5 : clampN(0.15 + (arr.length % 3) * 0.35, 0.12, 0.88);
      const y = arr.length === 0 ? 0.32 : clampN(0.22 + Math.floor(arr.length / 3) * 0.22, 0.15, 0.72);
      const newItem = { url, x, y, scale: 0.24, backing: 'none' };
      setActiveUrl(url);
      return [...arr, newItem];
    });
  };

  const startMove = (url, e) => {
    e.preventDefault();
    setActiveUrl(url);
    const it = items.find((i) => i.url === url);
    const { x, y } = norm(e);
    dragOffset.current = { dx: (it?.x || 0.5) - x, dy: (it?.y || 0.32) - y };
    gesture.current = { type: 'move', url };
    canvasRef.current?.setPointerCapture(e.pointerId);
  };

  const startResize = (url, e) => {
    e.preventDefault();
    e.stopPropagation();
    setActiveUrl(url);
    gesture.current = { type: 'resize', url };
    canvasRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    if (!gesture.current) return;
    const { x, y } = norm(e);
    const { type, url } = gesture.current;
    setItems((arr) => arr.map((it) => {
      if (it.url !== url) return it;
      if (type === 'move') {
        return { ...it, x: clampN(x + dragOffset.current.dx, 0.05, 0.95), y: clampN(y + dragOffset.current.dy, 0.05, 0.95) };
      }
      return { ...it, scale: clampN(Math.abs(x - it.x) * 2, COVER_BOUNDS.min, COVER_BOUNDS.max) };
    }));
  };

  const endGesture = (e) => {
    gesture.current = null;
    try { canvasRef.current?.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const setScale = (url, scale) => {
    setItems((arr) => arr.map((it) => (it.url === url ? { ...it, scale: clampN(scale, COVER_BOUNDS.min, COVER_BOUNDS.max) } : it)));
  };

  const setBacking = (url, backing) => {
    setItems((arr) => arr.map((it) => (it.url === url ? { ...it, backing } : it)));
  };

  const save = () => {
    const primary = items[0];
    const nextCustom = custom ? { ...custom } : {};
    if (primary) {
      nextCustom.cover = { x: primary.x, y: primary.y, scale: primary.scale };
      nextCustom.backing = primary.backing || 'none';
    } else {
      delete nextCustom.cover;
      delete nextCustom.backing;
    }
    const coverLogos = items.slice(1).map(({ url, x, y, scale }) => ({ url, x, y, scale }));
    onSave({ logoUrl: primary?.url || '', custom: Object.keys(nextCustom).length ? nextCustom : null, coverLogos });
  };

  const agencyText = (brandName || 'Agency').toUpperCase();

  return (
    <div style={placerOverlay} onClick={onClose}>
      <div style={placerModal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 15 }}>Front cover logos</h3>
            <p style={{ ...fieldHint, marginTop: 2 }}>Previews the <strong>{templateName}</strong> template · choose images, drag &amp; resize on the cover.</p>
          </div>
          <button type="button" onClick={onClose} style={iconBtn} aria-label="Close"><X size={16} /></button>
        </div>

        <div style={{ ...fieldLabel, marginBottom: 8 }}>
          <span>Choose logos <span style={fieldHint}>(tap to include — one, several, or all)</span></span>
          {pool.length === 0 ? (
            <p style={fieldHint}>Upload images first — they&apos;ll appear here to choose from.</p>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
              {pool.map((url) => {
                const on = items.some((it) => it.url === url);
                return (
                  <button key={url} type="button" onClick={() => toggle(url)}
                    style={{ position: 'relative', border: on ? '2px solid var(--primary-color, var(--accent-color))' : '1px solid var(--border-color)', borderRadius: 8, padding: 5, background: 'var(--surface-color)', cursor: 'pointer', width: 70, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <img src={url} alt="" style={{ maxHeight: 32, maxWidth: 58, objectFit: 'contain', opacity: on ? 1 : 0.55 }} />
                    {on && <span style={{ position: 'absolute', top: -7, right: -7, height: 16, width: 16, borderRadius: '50%', background: 'var(--primary-color, var(--accent-color))', color: '#fff', fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✓</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div
          ref={canvasRef}
          onPointerMove={onPointerMove}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
          style={{
            position: 'relative', aspectRatio: '210 / 297', width: '100%', maxWidth: 360, margin: '0 auto', touchAction: 'none', userSelect: 'none',
            overflow: 'hidden', borderRadius: 8, border: '1px solid var(--border-color)',
            background: family === 'editorial'
              ? 'linear-gradient(to bottom, #78716c, #44403c, #1c1917)'
              : 'linear-gradient(to bottom, #475569, #0f172a, #000)',
          }}
        >
          {family === 'banded' && (
            <div style={{ position: 'absolute', left: '50%', top: '46%', transform: 'translate(-50%,-50%)', width: '70%', aspectRatio: '1 / 1', borderRadius: '50%', background: accent, opacity: 0.82 }} />
          )}

          {/* Approximate text-region guides so logos can be placed to avoid them. */}
          {family === 'editorial' ? (
            <>
              <div style={{ position: 'absolute', top: '4%', left: '8%', right: '8%', border: '1px dashed rgba(255,255,255,0.35)', background: 'rgba(0,0,0,0.18)', borderRadius: 3, padding: '3px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'rgba(255,255,255,0.65)', fontSize: 6, letterSpacing: 1, textTransform: 'uppercase' }}>
                <span>Agency / date</span>
                <span>Season</span>
              </div>
              <div style={{ position: 'absolute', right: '4%', top: '45%', transform: 'translateY(-50%) rotate(90deg)', transformOrigin: 'right center', border: '1px dashed rgba(255,255,255,0.35)', background: 'rgba(0,0,0,0.18)', borderRadius: 3, padding: '2px 6px', color: 'rgba(255,255,255,0.65)', fontSize: 6, letterSpacing: 1, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Edition · Year</div>
              <div style={{ position: 'absolute', left: '8%', right: '8%', bottom: '16%', border: '1px dashed rgba(255,255,255,0.35)', background: 'rgba(0,0,0,0.18)', borderRadius: 3, padding: 8, color: 'rgba(255,255,255,0.8)' }}>
                <div style={{ fontSize: 6, letterSpacing: 1, textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)' }}>Kicker</div>
                <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.1, margin: '2px 0' }}>Trip Title</div>
                <div style={{ fontSize: 7, color: 'rgba(255,255,255,0.65)' }}>Subtitle / route line</div>
              </div>
              <div style={{ position: 'absolute', left: '8%', right: '8%', bottom: '5%', border: '1px dashed rgba(255,255,255,0.35)', background: 'rgba(0,0,0,0.18)', borderRadius: 3, padding: '4px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'rgba(255,255,255,0.65)', fontSize: 6, letterSpacing: 1 }}>
                <span>AGENCY</span>
                <span>BADGE</span>
              </div>
            </>
          ) : (
            <>
              <div style={{ position: 'absolute', top: '4%', left: '8%', right: '8%', border: '1px dashed rgba(255,255,255,0.35)', background: 'rgba(0,0,0,0.18)', borderRadius: 3, padding: '3px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'rgba(255,255,255,0.65)', fontSize: 6, letterSpacing: 1, textTransform: 'uppercase' }}>
                <span>{agencyText}</span>
                <span>Season</span>
              </div>
              <div style={{ position: 'absolute', left: '10%', right: '10%', top: '36%', border: '1px dashed rgba(255,255,255,0.35)', background: 'rgba(0,0,0,0.18)', borderRadius: 3, padding: 10, textAlign: 'center', color: 'rgba(255,255,255,0.8)' }}>
                <div style={{ fontSize: 6, letterSpacing: 1, textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)' }}>Kicker</div>
                <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.1, margin: '3px 0' }}>Trip Title</div>
                <div style={{ fontSize: 7, color: 'rgba(255,255,255,0.65)' }}>Subtitle / route line</div>
              </div>
              <div style={{ position: 'absolute', left: '8%', right: '8%', bottom: '5%', display: 'flex', justifyContent: 'space-between' }}>
                <div style={{ border: '1px dashed rgba(255,255,255,0.35)', background: 'rgba(0,0,0,0.18)', borderRadius: 3, padding: '4px 6px', color: 'rgba(255,255,255,0.65)', fontSize: 6, letterSpacing: 1 }}>AGENCY</div>
                <div style={{ border: '1px dashed rgba(255,255,255,0.35)', background: 'rgba(0,0,0,0.18)', borderRadius: 12, padding: '4px 8px', color: 'rgba(255,255,255,0.65)', fontSize: 6, letterSpacing: 1 }}>BADGE</div>
              </div>
            </>
          )}
          {items.map((it) => {
            const plated = it.backing === 'plate';
            const bareShadow = plated ? undefined : 'drop-shadow(0 2px 9px rgba(0,0,0,.55))';
            const isActive = activeUrl === it.url;
            const shadows = [];
            if (plated) shadows.push('0 2px 8px rgba(0,0,0,0.3)');
            if (isActive) shadows.push('0 0 0 2px var(--primary-color, var(--accent-color))');
            return (
              <div
                key={it.url}
                onPointerDown={(e) => startMove(it.url, e)}
                style={{
                  position: 'absolute', left: `${it.x * 100}%`, top: `${it.y * 100}%`, width: `${it.scale * 100}%`,
                  transform: 'translate(-50%, -50%)', cursor: 'grab', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  borderRadius: 2, padding: plated ? 4 : 0, background: plated ? 'rgba(255,255,255,0.9)' : 'transparent',
                  boxShadow: shadows.join(', ') || 'none',
                }}
              >
                <img src={it.url} alt="logo" style={{ pointerEvents: 'none', display: 'block', width: '100%', height: 'auto', objectFit: 'contain', filter: bareShadow }} />
                <span onPointerDown={(e) => startResize(it.url, e)} title="Drag to resize" style={{ position: 'absolute', bottom: -7, right: -7, height: 14, width: 14, cursor: 'nwse-resize', borderRadius: '50%', border: '2px solid #fff', background: 'var(--primary-color, var(--accent-color))' }} />
              </div>
            );
          })}
        </div>

        {activeItem && (
          <div style={{ marginTop: 12, padding: 12, borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--subtle-bg)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <img src={activeItem.url} alt="" style={{ maxHeight: 28, maxWidth: 50, objectFit: 'contain' }} />
              <span style={{ fontSize: 12, fontWeight: 600 }}>Selected logo</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ width: 40, fontSize: 11, color: 'var(--text-secondary)' }}>Size</span>
              <input type="range" min={COVER_BOUNDS.min} max={COVER_BOUNDS.max} step={0.01} value={activeItem.scale} onChange={(e) => setScale(activeItem.url, Number(e.target.value))} style={{ flex: 1 }} />
              <span style={{ width: 36, textAlign: 'right', fontSize: 10, color: 'var(--text-secondary)' }}>{Math.round(activeItem.scale * 100)}%</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 40, fontSize: 11, color: 'var(--text-secondary)' }}>Backing</span>
              <div style={{ display: 'flex', overflow: 'hidden', borderRadius: 6, border: '1px solid var(--border-color)' }}>
                {['none', 'plate'].map((b) => (
                  <button key={b} type="button" onClick={() => setBacking(activeItem.url, b)} style={{ padding: '4px 8px', fontSize: 10, border: 'none', cursor: 'pointer', background: activeItem.backing === b ? 'var(--primary-color, var(--accent-color))' : 'var(--surface-color)', color: activeItem.backing === b ? '#fff' : 'var(--text-secondary)' }}>
                    {b === 'none' ? 'As uploaded' : 'White plate'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: 12, marginTop: 16 }}>
          <button type="button" onClick={() => { setItems([]); setActiveUrl(null); }} style={{ ...chipBtn, textDecoration: 'underline' }} title="Remove all front-cover logos">Clear</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={onClose} style={secondaryBtn}>Cancel</button>
            <button type="button" onClick={save} style={{ ...primaryBtn, width: 'auto' }} data-testid="cover-placer-save">Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}


// ─── Interior logo band placer ──────────────────────────────────────────────
// Mirrors the engine's customMarkH() so the preview is WYSIWYG-accurate to the PDF:
// a horizontal band (header or bottom) of logos chosen from the uploaded pool, all at
// one shared height, each dragged to its horizontal position. Banded honours header
// only (full-bleed bottom can't reflow), so the preview shows header for TMC + bottom.
function bandLogoHeightMm(scale, band, family) {
  const top = family === 'banded' ? true : band !== 'bottom'; // banded clamps bottom→top
  const maxH = family === 'editorial' ? (top ? 30 : 20) : 24;
  const minH = 9;
  const t = clampN((scale - 0.06) / (0.3 - 0.06), 0, 1);
  return clampN(minH + t * (maxH - minH), minH, maxH);
}

function InteriorBandPlacer({ pool, value, family, onSave, onClose }) {
  const [band, setBand] = useState(value?.band || 'header');
  const [scale, setScale] = useState(value?.scale ?? 0.16);
  const [items, setItems] = useState(() => (Array.isArray(value?.items) ? value.items.filter((it) => pool.includes(it.url)) : []));
  const canvasRef = useRef(null);
  const dragUrl = useRef(null);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const effBand = family === 'banded' && band === 'bottom' ? 'header' : band; // banded → header
  const hMm = bandLogoHeightMm(scale, effBand, family);
  const hPct = (hMm / 297) * 100; // logo height as % of page height — WYSIWYG
  const topPct = ((family === 'banded' ? 6 : 9) / 297) * 100;
  const botPct = (8 / 297) * 100;

  const toggle = (url) => setItems((arr) => {
    const has = arr.some((it) => it.url === url);
    if (has) return arr.filter((it) => it.url !== url);
    if (arr.length >= 8) return arr;
    const x = arr.length === 0 ? 0.5 : clampN(arr.length / (arr.length + 1), 0.08, 0.92);
    return [...arr, { url, x }];
  });
  const normX = (e) => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return 0.5;
    return clampN((e.clientX - r.left) / r.width, 0.05, 0.95);
  };
  const onMove = (e) => {
    if (!dragUrl.current) return;
    const x = normX(e);
    setItems((arr) => arr.map((it) => (it.url === dragUrl.current ? { ...it, x } : it)));
  };
  const endDrag = (e) => { dragUrl.current = null; try { canvasRef.current?.releasePointerCapture(e.pointerId); } catch { /* ignore */ } };

  return (
    <div style={placerOverlay} onClick={onClose}>
      <div style={placerModal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 15 }}>Logos on pages after the cover</h3>
            <p style={{ ...fieldHint, marginTop: 2 }}>Pick logos from your kit, choose a band, then drag each across it. Page text reflows clear of it so nothing clashes.{family === 'banded' ? ' (TMC uses the header band.)' : ''}</p>
          </div>
          <button type="button" onClick={onClose} style={iconBtn} aria-label="Close"><X size={16} /></button>
        </div>

        {/* Pool selector */}
        <div style={{ ...fieldLabel, marginBottom: 8 }}>
          <span>Choose logos <span style={fieldHint}>(tap to include — one, several, or all)</span></span>
          {pool.length === 0 ? (
            <p style={fieldHint}>Upload a logo / cover logos first — they&rsquo;ll appear here to choose from.</p>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
              {pool.map((url) => {
                const on = items.some((it) => it.url === url);
                return (
                  <button key={url} type="button" onClick={() => toggle(url)}
                    style={{ position: 'relative', border: on ? '2px solid var(--primary-color, var(--accent-color))' : '1px solid var(--border-color)', borderRadius: 8, padding: 5, background: 'var(--surface-color)', cursor: 'pointer', width: 70, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <img src={url} alt="" style={{ maxHeight: 32, maxWidth: 58, objectFit: 'contain', opacity: on ? 1 : 0.55 }} />
                    {on && <span style={{ position: 'absolute', top: -7, right: -7, height: 16, width: 16, borderRadius: '50%', background: 'var(--primary-color, var(--accent-color))', color: '#fff', fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✓</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* WYSIWYG canvas */}
        <div
          ref={canvasRef}
          onPointerMove={onMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          style={{ position: 'relative', aspectRatio: '210 / 297', width: 200, margin: '0 auto', touchAction: 'none', userSelect: 'none', overflow: 'hidden', borderRadius: 8, border: '1px solid var(--border-color)', background: '#fff' }}
        >
          <div style={{ position: 'absolute', left: '10%', right: '10%', top: `${topPct + (effBand === 'header' ? hPct + 3 : 0)}%`, bottom: `${effBand === 'bottom' ? hPct + 3 : 6}%` }}>
            {['90%', '70%', '80%', '55%', '85%', '60%'].map((w, i) => (
              <div key={i} style={{ height: 4, borderRadius: 2, background: '#cbd5e1', width: w, marginBottom: 7 }} />
            ))}
          </div>
          {items.map((it) => (
            <img
              key={it.url}
              src={it.url}
              alt=""
              onPointerDown={(e) => { e.preventDefault(); dragUrl.current = it.url; canvasRef.current?.setPointerCapture(e.pointerId); }}
              style={{ position: 'absolute', left: `${it.x * 100}%`, [effBand === 'bottom' ? 'bottom' : 'top']: `${effBand === 'bottom' ? botPct : topPct}%`, height: `${hPct}%`, width: 'auto', maxWidth: '40%', objectFit: 'contain', transform: 'translateX(-50%)', cursor: 'grab', filter: 'drop-shadow(0 1px 5px rgba(0,0,0,.35))' }}
            />
          ))}
        </div>

        {/* Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <span style={{ width: 50, fontSize: 11, color: 'var(--text-secondary)' }}>Band</span>
          <div style={{ display: 'flex', overflow: 'hidden', borderRadius: 6, border: '1px solid var(--border-color)' }}>
            {['header', 'bottom'].map((b) => (
              <button key={b} type="button" onClick={() => setBand(b)} style={{ padding: '5px 12px', fontSize: 11, border: 'none', cursor: 'pointer', background: band === b ? 'var(--primary-color, var(--accent-color))' : 'var(--surface-color)', color: band === b ? '#fff' : 'var(--text-secondary)' }}>
                {b === 'header' ? 'Header (top)' : 'Bottom'}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <span style={{ width: 50, fontSize: 11, color: 'var(--text-secondary)' }}>Size</span>
          <input type="range" min={INNER_BOUNDS.min} max={INNER_BOUNDS.max} step={0.01} value={scale} onChange={(e) => setScale(Number(e.target.value))} style={{ flex: 1 }} />
          <span style={{ width: 32, textAlign: 'right', fontSize: 10, color: 'var(--text-secondary)' }}>{Math.round(scale * 100)}%</span>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: 12, marginTop: 16 }}>
          <button type="button" onClick={() => onSave(null)} style={{ ...chipBtn, textDecoration: 'underline' }} title="Remove the interior logo band">Clear band</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={onClose} style={secondaryBtn}>Cancel</button>
            <button type="button" onClick={() => onSave(items.length ? { band, scale, items } : null)} style={{ ...primaryBtn, width: 'auto' }} data-testid="band-save">Save</button>
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
