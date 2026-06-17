import React, { useState, useEffect, useContext, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Trash2, Zap, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { formatMoney, currencySymbol } from '../utils/money';
import { io } from 'socket.io-client';
import DealModal from '../components/DealModal';
import { AuthContext } from '../App';

// C4 (PRD_TRAVEL_PIPELINE_KANBAN FR-3.18) — virtualization threshold.
// Columns with >100 cards render only a windowed slice based on scroll
// position. Below this threshold all cards render — small enough to skip
// the windowing overhead. Exported as a const so the test file can pin it.
export const VIRTUALIZATION_THRESHOLD = 100;
// Approximate height of a single card (h4 + company line + amount row + gap).
// Tuned to keep ~20 cards in the DOM at any time for a 200+ card column.
const CARD_ROW_HEIGHT = 132;
const VIRTUAL_BUFFER_CARDS = 5;

// #897 (PRD_TRAVEL_PIPELINE_KANBAN) — Travel-vertical sub-brand filter.
// 4 sub-brands per the multi-tenant travel architecture.
const TRAVEL_SUB_BRANDS = [
  { value: '', label: 'All sub-brands' },
  { value: 'tmc', label: 'TMC (School trips)' },
  { value: 'rfu', label: 'RFU (Umrah)' },
  { value: 'travelstall', label: 'Travel Stall (Family)' },
  { value: 'visasure', label: 'Visa Sure' },
];

const defaultStages = [
  { id: 'lead', title: 'New Lead', color: 'var(--accent-color)' },
  { id: 'contacted', title: 'Contacted', color: 'var(--warning-color)' },
  { id: 'proposal', title: 'Proposal Sent', color: '#a855f7' },
  { id: 'won', title: 'Closed Won', color: 'var(--success-color)' }
];

// Slugify a PipelineStage.name into the column id used both as React key
// and as the deal's `stage` slug in the backend. Mirrors the backend's
// slugifyStageName in routes/deals.js so frontend column ids and backend
// `Deal.stage` values stay in lockstep across verticals.
export const slugifyStageName = (name) =>
  String(name || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

const Pipeline = () => {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isTravelTenant = user?.tenant?.vertical === 'travel';
  const [deals, setDeals] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [stages, setStages] = useState(defaultStages);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [newDeal, setNewDeal] = useState({ title: '', company: '', contactName: '', amount: '', probability: '', stage: 'lead' });
  const [aiScoreModal, setAiScoreModal] = useState(null);
  const [selectedDeal, setSelectedDeal] = useState(null);
  // #897 (PRD_TRAVEL_PIPELINE_KANBAN FR-5) — sub-brand filter for
  // Travel-vertical tenants. Empty string = no filter (all sub-brands).
  // Generic + wellness tenants don't see the dropdown; filter stays ''.
  //
  // C3 (FR-3.15) — URL-param persistence via useSearchParams. Initial state
  // seeds from `?subBrand=tmc` (or the first valid value in a comma list like
  // `?subBrand=tmc,rfu`, forward-compat for a multi-select C4 may add later).
  // Unknown / empty values fall back to '' (all sub-brands). The first effect
  // syncs the URL when the dropdown changes; the second effect re-seeds local
  // state when the URL changes externally (back-button, deep-link nav).
  const [searchParams, setSearchParams] = useSearchParams();
  const _validSubBrands = TRAVEL_SUB_BRANDS.map((sb) => sb.value).filter(Boolean);
  const parseSubBrandParam = (raw) => {
    if (!raw) return '';
    const first = raw.split(',').map((s) => s.trim()).find((s) => _validSubBrands.includes(s));
    return first || '';
  };
  const [selectedSubBrand, setSelectedSubBrand] = useState(() =>
    parseSubBrandParam(searchParams.get('subBrand')),
  );

  // C4 (FR-3.17) — keyboard a11y. `keyboardMoveDealId` is the id of a card
  // currently in "move mode" (set when user presses Space on a focused card;
  // arrow keys then move the card; second Space drops it; Esc cancels).
  // `announcement` feeds the visually-hidden aria-live region the screen
  // reader announces after a drop ("Moved {deal} from {old} to {new}").
  const [keyboardMoveDealId, setKeyboardMoveDealId] = useState(null);
  const [announcement, setAnnouncement] = useState('');

  // C4 (FR-3.18) — per-column scroll position drives the windowed slice.
  // We track scrollTop per stage.id; when a column has >threshold cards,
  // only cards within ±buffer of the visible window render.
  const [scrollPositions, setScrollPositions] = useState({});

  // C4 (FR-3.16) — touch-drag state. HTML5 DragEvent doesn't fire on touch
  // devices; we synthesize the drop by tracking the held card and the
  // column the touchEnd lands in. `touchDragDealId` is the in-flight card.
  const touchDragRef = useRef({ dealId: null, startY: 0 });

  // C4 — reduced-motion preference; skip drag animations / transitions when set.
  const prefersReducedMotion = useMemo(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }, []);

  // C3 — push selectedSubBrand → URL. Empty selection removes the param
  // entirely so deep-links stay clean (`/pipeline` not `/pipeline?subBrand=`).
  useEffect(() => {
    const current = searchParams.get('subBrand') || '';
    if (!selectedSubBrand) {
      if (current) {
        searchParams.delete('subBrand');
        setSearchParams(searchParams, { replace: true });
      }
      return;
    }
    if (current !== selectedSubBrand) {
      searchParams.set('subBrand', selectedSubBrand);
      setSearchParams(searchParams, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSubBrand]);

  // C3 — pull URL → selectedSubBrand. Fires on browser back/forward or any
  // external nav that mutates the `subBrand` param. Guarded against the
  // echo loop by only writing local state when the parsed URL value
  // diverges from the current selection.
  useEffect(() => {
    const fromUrl = parseSubBrandParam(searchParams.get('subBrand'));
    if (fromUrl !== selectedSubBrand) {
      setSelectedSubBrand(fromUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const fetchAiScore = async (e, dealId) => {
    e.stopPropagation();
    try {
      const data = await fetchApi(`/api/ai_scoring/score/${dealId}`);
      setAiScoreModal(data);
    } catch(err) {
      notify.error("Failed to connect to AI Predictor.");
    }
  };

  useEffect(() => {
    Promise.all([
      fetchApi('/api/deals').catch(() => []),
      fetchApi('/api/contacts').catch(() => []),
      fetchApi('/api/pipeline_stages').catch(() => [])
    ]).then(([dealData, contactData, stageData]) => {
      setDeals(Array.isArray(dealData) ? dealData : []);
      setContacts(Array.isArray(contactData) ? contactData : []);
      if (Array.isArray(stageData) && stageData.length > 0) {
        // Derive the column id by slugifying the stage's own name. The
        // previous hardcoded map only knew the generic-CRM names
        // (lead/contacted/proposal/won/lost) and silently dropped every
        // travel-vertical stage (New, Diagnostic Complete, Qualifying,
        // Quoted, Negotiating, Dormant) because they weren't in the lookup,
        // leaving the Travel pipeline rendering only Won/Lost.
        //
        // #575 dedupe contract preserved: stages whose names slugify to the
        // same id collapse — first by position order (backend sorts asc)
        // wins. Guards against historical duplicates like both "Lead" and
        // "New Lead" double-rendering identical card sets.
        const seen = new Set();
        const dedupedStages = [];
        for (const s of stageData) {
          const id = slugifyStageName(s.name);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          dedupedStages.push({ id, title: s.name, color: s.color, dbId: s.id });
        }
        if (dedupedStages.length > 0) setStages(dedupedStages);
      }
      setLoading(false);
    }).catch(err => console.error(err));

    const socket = io('/', {
      reconnection: false, // don't spam reconnect errors
      timeout: 5000,
    });
    
    socket.on('connect_error', () => { /* silently ignore — nginx may not proxy socket.io */ });
    socket.on('error', () => { /* silently ignore */ });

    socket.on('deal_updated', (updatedDeal) => {
      setDeals(prevDeals => {
        const exists = prevDeals.find(d => d.id === updatedDeal.id);
        if (exists) {
          return prevDeals.map(d => d.id === updatedDeal.id ? updatedDeal : d);
        } else {
          return [updatedDeal, ...prevDeals];
        }
      });
    });

    socket.on('deal_deleted', (deletedId) => {
      setDeals(prevDeals => prevDeals.filter(d => d.id !== deletedId));
    });

    return () => socket.disconnect();
  }, []);

  const handleAddDeal = async (e) => {
    e.preventDefault();
    const fallbackStage = stages[0]?.id || 'lead';
    try {
      const created = await fetchApi('/api/deals', {
        method: 'POST',
        body: JSON.stringify({
          title: newDeal.title,
          amount: parseFloat(newDeal.amount) || 0,
          probability: parseInt(newDeal.probability) || 50,
          stage: newDeal.stage || fallbackStage,
        })
      });
      // Optimistically add to local state in case socket.io is slow
      if (created && created.id) {
        setDeals(prev => [created, ...prev]);
      }
      // Also refresh from server for reliability
      fetchApi('/api/deals').then(data => {
        if (Array.isArray(data)) setDeals(data);
      }).catch(() => {});
    } catch (err) {
      console.error('Failed to create deal:', err);
    }
    setShowModal(false);
    setNewDeal({ title: '', company: '', contactName: '', amount: '', probability: '', stage: fallbackStage });
  };

  const handleDelete = async (e, id) => {
    e.stopPropagation();
    if (!await notify.confirm({
      title: 'Delete deal',
      message: 'Delete this deal?',
      confirmText: 'Delete',
      destructive: true,
    })) return;
    await fetchApi(`/api/deals/${id}`, { method: 'DELETE' });
  };

  const handleDragStart = (e, id) => {
    e.dataTransfer.setData('dealId', id);
  };

  // #605: stage→default-probability mapping. Won/lost are absolute (server
  // enforces the same; mirrored here for instant UI). Intermediate stages get
  // the conventional CRM probabilities so the per-column weighted total +
  // the forecast widget update at drop time, not on next refresh.
  //
  // Both generic-CRM slugs (lead/contacted/proposal/negotiation) and
  // travel-vertical slugs (new/diagnostic-complete/qualifying/quoted/
  // negotiating/dormant) are covered; verticals that introduce a new stage
  // slug without an entry here fall through to the server's stored
  // probability on drop (no client-side optimistic update for the badge).
  const STAGE_PROBABILITY = {
    // generic
    lead: 25,
    contacted: 40,
    proposal: 70,
    negotiation: 80,
    // travel
    new: 25,
    'diagnostic-complete': 30,
    qualifying: 40,
    quoted: 60,
    negotiating: 80,
    dormant: 10,
    // terminal (all verticals)
    won: 100,
    lost: 0,
  };

  const handleDrop = async (e, stageId) => {
    e.preventDefault();
    const dealId = parseInt(e.dataTransfer.getData('dealId'));
    if (!dealId) return;

    // #605: snapshot current state for rollback + optimistically update both
    // stage AND probability so the badge / column total / forecast reflect
    // the new stage immediately, before the network round-trip.
    const prevDeals = deals;
    const newProb = STAGE_PROBABILITY[stageId];
    setDeals(prev => prev.map(d => {
      if (d.id !== dealId) return d;
      return newProb !== undefined ? { ...d, stage: stageId, probability: newProb } : { ...d, stage: stageId };
    }));

    try {
      const updated = await fetchApi(`/api/deals/${dealId}`, {
        method: 'PUT',
        body: JSON.stringify(
          newProb !== undefined ? { stage: stageId, probability: newProb } : { stage: stageId }
        ),
      });
      // Reconcile with server's authoritative copy (probability may differ if
      // the server applied terminal-stage rules or per-tenant overrides).
      if (updated && updated.id) {
        setDeals(prev => prev.map(d => d.id === updated.id ? { ...d, ...updated } : d));
      }
    } catch (err) {
      // Roll back to the pre-drop state on failure.
      setDeals(prevDeals);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
  };

  // C4 (FR-3.16) — touch-drag. HTML5 drag events don't fire on touch
  // devices; synthesize the drop by tracking the held card on touchStart
  // and finding the column the touchEnd lands in via elementFromPoint.
  // Mirrors the HTML5 drop semantics (optimistic update + rollback in
  // handleDrop) by funnelling through the same code path with a synthetic
  // dataTransfer.
  const handleCardTouchStart = (e, dealId) => {
    touchDragRef.current = { dealId, startY: e.touches[0].clientY };
  };

  const handleCardTouchEnd = async (e) => {
    const { dealId } = touchDragRef.current;
    touchDragRef.current = { dealId: null, startY: 0 };
    if (!dealId) return;

    // Find the column at the touchEnd coordinates. `changedTouches[0]` is
    // where the finger lifted; `elementFromPoint` walks the tree to find
    // the dropped-on column via the `data-stage-id` attribute we set on
    // the column wrapper.
    const touch = e.changedTouches && e.changedTouches[0];
    if (!touch) return;
    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    const column = target && target.closest('[data-stage-id]');
    if (!column) return;
    const stageId = column.getAttribute('data-stage-id');
    if (!stageId) return;

    // Funnel through the same code path as HTML5 drop — synthesize a
    // minimal dataTransfer so handleDrop's existing rollback / optimistic-
    // update logic catches the touch path too.
    await handleDrop({
      preventDefault: () => {},
      dataTransfer: { getData: () => String(dealId) },
    }, stageId);
  };

  // C4 (FR-3.17) — keyboard a11y. Per the PRD:
  //   Tab → focus first card
  //   Arrow Up/Down → move focus within a column
  //   Arrow Left/Right → move focus across columns at same vertical position
  //   Space → enter / exit "move mode" (second Space drops; Esc cancels)
  //   In move mode: arrows move the CARD itself, not focus.
  // The keyboardMoveDealId state distinguishes the two modes.
  const filterStageDeals = useCallback(
    (stage) =>
      deals.filter(
        (d) =>
          d.stage === stage.id &&
          (!selectedSubBrand || d.subBrand === selectedSubBrand),
      ),
    [deals, selectedSubBrand],
  );

  const focusCardByPosition = (stageIndex, dealIndex) => {
    // Find the card via data attributes. Falls back gracefully when the
    // target column has fewer cards than dealIndex (move to last card).
    const stage = stages[stageIndex];
    if (!stage) return;
    const targetStageDeals = filterStageDeals(stage);
    if (targetStageDeals.length === 0) return;
    const clampedIndex = Math.min(dealIndex, targetStageDeals.length - 1);
    const targetDeal = targetStageDeals[clampedIndex];
    if (!targetDeal) return;
    const el = document.querySelector(`[data-deal-id="${targetDeal.id}"]`);
    if (el && typeof el.focus === 'function') {
      el.focus();
    }
  };

  const announceMove = (deal, oldStageId, newStageId) => {
    const oldStage = stages.find((s) => s.id === oldStageId);
    const newStage = stages.find((s) => s.id === newStageId);
    setAnnouncement(
      `Moved ${deal.title} from ${oldStage ? oldStage.title : oldStageId} to ${newStage ? newStage.title : newStageId}`,
    );
  };

  const moveCardToStage = async (dealId, newStageId) => {
    const deal = deals.find((d) => d.id === dealId);
    if (!deal) return;
    const oldStageId = deal.stage;
    if (oldStageId === newStageId) return;

    const prevDeals = deals;
    const newProb = STAGE_PROBABILITY[newStageId];
    setDeals((prev) =>
      prev.map((d) => {
        if (d.id !== dealId) return d;
        return newProb !== undefined
          ? { ...d, stage: newStageId, probability: newProb }
          : { ...d, stage: newStageId };
      }),
    );
    announceMove(deal, oldStageId, newStageId);

    try {
      const updated = await fetchApi(`/api/deals/${dealId}`, {
        method: 'PUT',
        body: JSON.stringify(
          newProb !== undefined ? { stage: newStageId, probability: newProb } : { stage: newStageId },
        ),
      });
      if (updated && updated.id) {
        setDeals((prev) => prev.map((d) => (d.id === updated.id ? { ...d, ...updated } : d)));
      }
    } catch (err) {
      setDeals(prevDeals);
    }
  };

  const handleCardKeyDown = (e, deal, stageIndex, dealIndex) => {
    const isMoveMode = keyboardMoveDealId === deal.id;

    if (e.key === 'Escape' && isMoveMode) {
      e.preventDefault();
      setKeyboardMoveDealId(null);
      setAnnouncement(`Cancelled move of ${deal.title}`);
      return;
    }

    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      if (isMoveMode) {
        // Second Space — drop in current column (commits whatever stage the
        // card has been moved into; even if it didn't change, exit move mode).
        setKeyboardMoveDealId(null);
        setAnnouncement(`Dropped ${deal.title}`);
      } else {
        // First Space — enter move mode.
        setKeyboardMoveDealId(deal.id);
        setAnnouncement(
          `Picked up ${deal.title}. Use arrow keys to move; Space to drop; Escape to cancel.`,
        );
      }
      return;
    }

    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      if (isMoveMode) {
        // Move the CARD itself.
        if (e.key === 'ArrowLeft' && stageIndex > 0) {
          moveCardToStage(deal.id, stages[stageIndex - 1].id);
        } else if (e.key === 'ArrowRight' && stageIndex < stages.length - 1) {
          moveCardToStage(deal.id, stages[stageIndex + 1].id);
        }
        // ArrowUp/ArrowDown within a column is a no-op for stage assignment
        // (the kanban groups by stage, not by intra-column order). Future
        // slice could add an `order` column to support intra-column reorder.
        return;
      }
      // Not in move mode — move FOCUS.
      if (e.key === 'ArrowUp') {
        focusCardByPosition(stageIndex, Math.max(0, dealIndex - 1));
      } else if (e.key === 'ArrowDown') {
        focusCardByPosition(stageIndex, dealIndex + 1);
      } else if (e.key === 'ArrowLeft' && stageIndex > 0) {
        focusCardByPosition(stageIndex - 1, dealIndex);
      } else if (e.key === 'ArrowRight' && stageIndex < stages.length - 1) {
        focusCardByPosition(stageIndex + 1, dealIndex);
      }
    }
  };

  // C4 (FR-3.18) — windowed slice for columns over the virtualization threshold.
  // Below threshold: render every card (no overhead). Above threshold: render
  // only cards within ±buffer of the visible window based on scrollTop. The
  // column wrapper keeps a phantom-height div so the scrollbar still tracks
  // the real total and the card-count badge still shows real total length.
  const computeVisibleRange = (totalCards, scrollTop, containerHeight = 600) => {
    if (totalCards <= VIRTUALIZATION_THRESHOLD) {
      return { startIndex: 0, endIndex: totalCards, useVirt: false };
    }
    const firstVisible = Math.floor(scrollTop / CARD_ROW_HEIGHT);
    const visibleCount = Math.ceil(containerHeight / CARD_ROW_HEIGHT);
    const startIndex = Math.max(0, firstVisible - VIRTUAL_BUFFER_CARDS);
    const endIndex = Math.min(totalCards, firstVisible + visibleCount + VIRTUAL_BUFFER_CARDS);
    return { startIndex, endIndex, useVirt: true };
  };

  const handleColumnScroll = (e, stageId) => {
    const scrollTop = e.currentTarget.scrollTop;
    setScrollPositions((prev) => {
      // Coalesce updates to roughly one per CARD_ROW_HEIGHT pixels — the
      // window shifts in card-height chunks, not pixel-by-pixel, so we avoid
      // a setState per scroll event.
      const prevTop = prev[stageId] || 0;
      if (Math.abs(scrollTop - prevTop) < CARD_ROW_HEIGHT / 2) return prev;
      return { ...prev, [stageId]: scrollTop };
    });
  };

  return (
    <div style={{ padding: '2rem', height: '100%', display: 'flex', flexDirection: 'column', animation: 'fadeIn 0.4s ease-out' }}>
      <header style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Sales Pipeline <span style={{fontSize: '0.8rem', color: 'var(--success-color)', marginLeft: '10px', padding: '2px 8px', borderRadius: '12px', border: '1px solid var(--success-color)', background: 'rgba(16, 185, 129, 0.1)'}}>Live Sync Active</span></h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Drag and drop deals to update stages in real-time across all users.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {/* #897 (PRD_TRAVEL_PIPELINE_KANBAN FR-5) — sub-brand filter
              only renders for Travel-vertical tenants. Generic + wellness
              tenants see no dropdown (subBrand isn't in their world). */}
          {isTravelTenant && (
            <select
              value={selectedSubBrand}
              onChange={(e) => setSelectedSubBrand(e.target.value)}
              aria-label="Filter by sub-brand"
              style={{
                padding: '0.5rem 0.75rem',
                borderRadius: '8px',
                background: 'var(--input-bg)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-color)',
                fontSize: '0.875rem',
                cursor: 'pointer',
              }}
            >
              {TRAVEL_SUB_BRANDS.map((sb) => (
                <option key={sb.value || 'all'} value={sb.value}>{sb.label}</option>
              ))}
            </select>
          )}
          <button onClick={() => {
            // Seed the modal's stage with the first column for the current
            // tenant so travel-vertical users don't land on the literal
            // 'lead' default (which won't match any column they can see).
            const firstStage = stages[0]?.id || 'lead';
            setNewDeal(prev => ({ ...prev, stage: firstStage }));
            setShowModal(true);
          }} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={18} /> Add Deal
          </button>
        </div>
      </header>

      {/* C4 (FR-3.17) — aria-live region for screen-reader announcements
          on card pickup / drop / cancel. Visually hidden via CSS-in-JS
          clip-path; `aria-live=polite` waits until the SR is idle. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="pipeline-announcer"
        style={{
          position: 'absolute',
          width: '1px',
          height: '1px',
          padding: 0,
          margin: '-1px',
          overflow: 'hidden',
          clip: 'rect(0,0,0,0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {announcement}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '2rem' }}>Loading deals...</div>
      ) : (
        <div style={{ display: 'flex', gap: '1.5rem', flex: 1, overflowX: 'auto', paddingBottom: '1rem' }}>
          {stages.map((stage, stageIndex) => {
            // #897 — filter cards by stage AND (Travel only) by sub-brand
            const stageDeals = filterStageDeals(stage);
            const totalValue = stageDeals.reduce((sum, d) => sum + (d.amount || 0), 0);

            // C4 (FR-3.18) — windowed slice for >100-card columns. Below
            // threshold: render every card. Above: render only the visible
            // window + buffer.
            const scrollTop = scrollPositions[stage.id] || 0;
            const { startIndex, endIndex, useVirt } = computeVisibleRange(
              stageDeals.length,
              scrollTop,
            );
            const visibleDeals = useVirt
              ? stageDeals.slice(startIndex, endIndex)
              : stageDeals;
            const topSpacer = useVirt ? startIndex * CARD_ROW_HEIGHT : 0;
            const bottomSpacer = useVirt
              ? Math.max(0, (stageDeals.length - endIndex) * CARD_ROW_HEIGHT)
              : 0;

            return (
              <div
                key={stage.id}
                className="glass"
                data-stage-id={stage.id}
                // #877 — explicit --column-bg override (darker than --surface-color
                // used by inner .card deal tiles) so columns visually separate
                // from cards in both dark and light themes. Token defined in
                // index.css across all 3 theme blocks.
                style={{ width: '320px', flexShrink: 0, display: 'flex', flexDirection: 'column', background: 'var(--column-bg, var(--glass-bg))' }}
                onDrop={(e) => handleDrop(e, stage.id)}
                onDragOver={handleDragOver}
              >
                <div style={{ padding: '1.25rem', borderBottom: `2px solid ${stage.color}` }}>
                  <h3 style={{ fontSize: '1rem', fontWeight: '600', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    {stage.title}
                    {/* The badge always shows the REAL total length, not the
                        windowed visible count — important when virtualization
                        is active (badge=200 while DOM has ~20 cards). */}
                    <span data-testid={`stage-count-${stage.id}`} style={{ fontSize: '0.75rem', padding: '2px 8px', background: 'var(--subtle-bg-3)', borderRadius: '12px' }}>{stageDeals.length}</span>
                  </h3>
                  <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginTop: '0.5rem', fontWeight: '500' }}>
                    {formatMoney(totalValue)}
                  </p>
                </div>

                <div
                  data-testid={`stage-body-${stage.id}`}
                  onScroll={(e) => handleColumnScroll(e, stage.id)}
                  style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', flex: 1, overflowY: 'auto', maxHeight: 'calc(100vh - 280px)' }}
                >
                  {/* C4 (FR-3.18) — top spacer keeps scrollbar position aligned
                      with the un-rendered cards above the visible window. */}
                  {topSpacer > 0 && <div style={{ height: topSpacer }} aria-hidden="true" />}

                  {visibleDeals.map((deal, visibleIdx) => {
                    // dealIndex is the position within stageDeals (the source
                    // of truth for keyboard nav); use startIndex offset when
                    // virtualized so arrow keys still target the right row.
                    const dealIndex = useVirt ? startIndex + visibleIdx : visibleIdx;
                    const isInMoveMode = keyboardMoveDealId === deal.id;
                    return (
                      <div
                        key={deal.id}
                        className="card table-row-hover"
                        data-deal-id={deal.id}
                        data-in-move-mode={isInMoveMode ? 'true' : 'false'}
                        draggable
                        tabIndex={0}
                        role="button"
                        aria-label={`Deal: ${deal.title}, stage ${stage.title}, ${deal.probability}% probability${isInMoveMode ? '. In move mode — arrows to move, Space to drop, Escape to cancel.' : ''}`}
                        onClick={() => setSelectedDeal(deal)}
                        onDragStart={(e) => handleDragStart(e, deal.id)}
                        onTouchStart={(e) => handleCardTouchStart(e, deal.id)}
                        onTouchEnd={handleCardTouchEnd}
                        onKeyDown={(e) => handleCardKeyDown(e, deal, stageIndex, dealIndex)}
                        style={{
                          padding: '1.2rem',
                          cursor: 'pointer',
                          position: 'relative',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.8rem',
                          minWidth: 0,
                          flexShrink: 0,
                          // C4 (FR-3.17) — visible focus + move-mode outline.
                          outline: isInMoveMode ? '2px solid var(--accent-color, #3b82f6)' : undefined,
                          // C4 — reduced-motion: skip transitions when the
                          // user has set `prefers-reduced-motion: reduce`.
                          transition: prefersReducedMotion ? 'none' : undefined,
                        }}
                      >
                        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', position: 'absolute', top: '0.75rem', right: '0.75rem' }}>
                          <button onClick={(e) => fetchAiScore(e, deal.id)} aria-label={`Generate deal score for ${deal.title}`} style={{ background: 'none', border: 'none', color: '#a855f7', cursor: 'pointer', padding: '0.25rem', display: 'flex' }} title="Generate AI Insights">
                            <Zap size={14} style={{transition: prefersReducedMotion ? 'none' : 'var(--transition)'}} onMouseOver={e => e.currentTarget.style.filter = 'drop-shadow(0 0 5px #a855f7)'} onMouseOut={e => e.currentTarget.style.filter = 'none'} />
                          </button>
                          <button onClick={(e) => handleDelete(e, deal.id)} aria-label={`Delete deal ${deal.title}`} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0.25rem', display: 'flex' }} title="Delete Deal">
                            <Trash2 size={14} style={{transition: prefersReducedMotion ? 'none' : 'var(--transition)'}} onMouseOver={e => e.currentTarget.style.color = '#ef4444'} onMouseOut={e => e.currentTarget.style.color = 'var(--text-secondary)'} />
                          </button>
                        </div>

                        <div style={{ paddingRight: '2.5rem' }}>
                          <h4 style={{ fontWeight: '700', fontSize: '0.95rem', marginBottom: '0.4rem', color: 'var(--text-primary)', lineHeight: '1.3', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{deal.title}</h4>
                          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {deal.company || deal.contactName || '—'}
                          </p>
                        </div>

                        <div style={{ borderTop: `1px solid var(--border-color)`, paddingTop: '0.8rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                          <div>
                            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.3rem', fontWeight: '500' }}>Amount</p>
                            <p style={{ fontSize: '1.2rem', fontWeight: 'bold', color: 'var(--text-primary)', marginBottom: '0' }}>
                              {formatMoney(deal.amount || 0, { currency: deal.currency })}
                            </p>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.3rem', fontWeight: '500' }}>Probability</p>
                            <span style={{ fontSize: '0.95rem', padding: '0.35rem 0.6rem', backgroundColor: `${stage.color}20`, color: stage.color, borderRadius: '4px', fontWeight: '700', display: 'inline-block' }}>
                              {deal.probability}%
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {/* C4 (FR-3.18) — bottom spacer balances scrollbar. */}
                  {bottomSpacer > 0 && <div style={{ height: bottomSpacer }} aria-hidden="true" />}

                  {stageDeals.length === 0 && (
                    <div style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.875rem', padding: '2rem 1rem', border: '1px dashed var(--border-color)', borderRadius: '12px' }}>
                      Drag deals here
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, animation: 'fadeIn 0.2s ease-out' }}>
          <div className="card modal" role="dialog" style={{ padding: '2.5rem', width: '450px' }}>
            <h3 style={{ marginBottom: '1.5rem', fontSize: '1.5rem', fontWeight: 'bold' }}>Add New Deal</h3>
            <form onSubmit={handleAddDeal} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <input type="text" placeholder="Deal Title" required className="input-field" value={newDeal.title} onChange={e => setNewDeal({...newDeal, title: e.target.value})} />
              <div style={{ display: 'flex', gap: '1rem' }}>
                <div style={{ flex: 1 }}>
                  <input type="text" list="contacts-list" placeholder="Contact Person" className="input-field" value={newDeal.contactName} onChange={e => setNewDeal({...newDeal, contactName: e.target.value})} />
                  <datalist id="contacts-list">
                    {contacts.map(c => <option key={c.id} value={c.name}>{c.company}</option>)}
                  </datalist>
                </div>
                <div style={{ flex: 1 }}>
                  <input type="text" list="companies-list" placeholder="Company Name" className="input-field" value={newDeal.company} onChange={e => setNewDeal({...newDeal, company: e.target.value})} />
                  <datalist id="companies-list">
                    {[...new Set(contacts.map(c => c.company))].filter(Boolean).map((comp, idx) => <option key={idx} value={comp} />)}
                  </datalist>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '1rem' }}>
                <input type="number" placeholder={`Amount (${currencySymbol()})`} required className="input-field" value={newDeal.amount} onChange={e => setNewDeal({...newDeal, amount: e.target.value})} />
                <input type="number" placeholder="Probability (%)" required className="input-field" value={newDeal.probability} onChange={e => setNewDeal({...newDeal, probability: e.target.value})} />
              </div>
              <select className="input-field" value={newDeal.stage} onChange={e => setNewDeal({...newDeal, stage: e.target.value})}>
                {stages.map(stage => (
                   <option key={stage.id} value={stage.id} style={{ background: 'var(--bg-color)' }}>{stage.title}</option>
                ))}
              </select>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '1rem' }}>
                <button type="button" onClick={() => setShowModal(false)} style={{ background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer', fontWeight: '500' }}>Cancel</button>
                <button type="submit" className="btn-primary">Save Deal</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {aiScoreModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 150, animation: 'fadeIn 0.3s ease-out' }}>
          <div className="card" style={{ padding: '2.5rem', width: '500px', border: '1px solid #a855f7', boxShadow: '0 10px 40px rgba(168, 85, 247, 0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              {/* #593: rebranded — backend/routes/ai_scoring.js is a rules engine
                  (stage weights + budget multiplier + activity bucket). No LLM. */}
              <h3 style={{ fontSize: '1.5rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Zap size={24} color="#a855f7" /> Deal Predictive Score
              </h3>
              <button onClick={() => setAiScoreModal(null)} aria-label="Close deal score dialog" title="Close" style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}><X size={24}/></button>
            </div>
            
            <div style={{ padding: '1.5rem', background: 'rgba(168, 85, 247, 0.05)', borderRadius: '12px', border: '1px solid rgba(168, 85, 247, 0.2)', marginBottom: '1.5rem' }}>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Deal Analysis</p>
              <h4 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1rem' }}>{aiScoreModal.title}</h4>
              
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Win Probability Score:</span>
                <span style={{ fontSize: '2rem', fontWeight: 'bold', color: aiScoreModal.probability > 70 ? 'var(--success-color)' : (aiScoreModal.probability > 40 ? 'var(--warning-color)' : 'var(--danger-color)') }}>
                  {aiScoreModal.probability}%
                </span>
              </div>
              
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Confidence Level:</span>
                <span style={{ padding: '0.25rem 0.75rem', borderRadius: '12px', backgroundColor: 'var(--subtle-bg-3)', fontSize: '0.875rem' }}>
                  {aiScoreModal.confidence}
                </span>
              </div>
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <h5 style={{ fontSize: '1rem', fontWeight: '600', marginBottom: '0.75rem' }}>Predictive Variables</h5>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div style={{ padding: '1rem', background: 'var(--subtle-bg)', borderRadius: '8px' }}>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Stage Weighting</p>
                  <p style={{ fontWeight: '500' }}>+{aiScoreModal.predictiveVariables.stageWeight}</p>
                </div>
                <div style={{ padding: '1rem', background: 'var(--subtle-bg)', borderRadius: '8px' }}>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Budget Bonus</p>
                  <p style={{ fontWeight: '500' }}>+{aiScoreModal.predictiveVariables.budgetBonus}</p>
                </div>
              </div>
            </div>
            
            <button className="btn-primary" style={{ width: '100%' }} onClick={() => setAiScoreModal(null)}>Dismiss Analysis</button>
          </div>
        </div>
      )}

      {selectedDeal && (
        <DealModal deal={selectedDeal} onClose={() => setSelectedDeal(null)} />
      )}

    </div>
  );
};

export default Pipeline;
