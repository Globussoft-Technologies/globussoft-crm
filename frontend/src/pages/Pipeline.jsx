import React, { useState, useEffect, useContext } from 'react';
import { Plus, Trash2, Zap, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { formatMoney, currencySymbol } from '../utils/money';
import { io } from 'socket.io-client';
import DealModal from '../components/DealModal';
import { AuthContext } from '../App';

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
  const [selectedSubBrand, setSelectedSubBrand] = useState('');

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
        // Map stage names to deal stage IDs used in the database. Note:
        // multiple stage names normalize to the same id (e.g. both "Lead"
        // and "New Lead" → 'lead', "Negotiation" and "Proposal Sent" →
        // 'proposal'). Deals' `stage` column is a slug, not a foreign key,
        // so this lossy normalization is required to hit the right cards.
        const stageIdMap = {
          'new lead': 'lead', 'lead': 'lead',
          'contacted': 'contacted',
          'proposal sent': 'proposal', 'proposal': 'proposal',
          'negotiation': 'proposal',
          'closed won': 'won', 'won': 'won',
          'closed lost': 'lost', 'lost': 'lost',
        };
        // #575 (regression of #173): dedupe by normalized id to keep the
        // kanban from rendering the same deal set in two columns whenever a
        // tenant has both "Lead" and "New Lead" (or any pair that collapses
        // to the same id). First stage wins — preserves DB position order
        // since pipeline_stages.GET sorts by position asc. Without this, the
        // page renders BOTH "New Lead" (99 / $90k) AND "Lead" (99 / $90k)
        // showing identical cards, double-counting the pipeline visually.
        const seen = new Set();
        const dedupedStages = [];
        for (const s of stageData) {
          const id = stageIdMap[s.name.toLowerCase()];
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
    try {
      const created = await fetchApi('/api/deals', {
        method: 'POST',
        body: JSON.stringify({
          title: newDeal.title,
          amount: parseFloat(newDeal.amount) || 0,
          probability: parseInt(newDeal.probability) || 50,
          stage: newDeal.stage || 'lead',
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
    setNewDeal({ title: '', company: '', contactName: '', amount: '', probability: '', stage: 'lead' });
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
  const STAGE_PROBABILITY = {
    lead: 25,
    contacted: 40,
    proposal: 70,
    negotiation: 80,
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
          <button onClick={() => setShowModal(true)} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={18} /> Add Deal
          </button>
        </div>
      </header>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '2rem' }}>Loading deals...</div>
      ) : (
        <div style={{ display: 'flex', gap: '1.5rem', flex: 1, overflowX: 'auto', paddingBottom: '1rem' }}>
          {stages.map(stage => {
            // #897 — filter cards by stage AND (Travel only) by sub-brand
            const stageDeals = deals.filter(d =>
              d.stage === stage.id &&
              (!selectedSubBrand || d.subBrand === selectedSubBrand)
            );
            const totalValue = stageDeals.reduce((sum, d) => sum + (d.amount || 0), 0);

            return (
              <div
                key={stage.id}
                className="glass"
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
                    <span style={{ fontSize: '0.75rem', padding: '2px 8px', background: 'var(--subtle-bg-3)', borderRadius: '12px' }}>{stageDeals.length}</span>
                  </h3>
                  <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginTop: '0.5rem', fontWeight: '500' }}>
                    {formatMoney(totalValue)}
                  </p>
                </div>
                
                <div style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', flex: 1, overflowY: 'auto', maxHeight: 'calc(100vh - 280px)' }}>
                  {stageDeals.map(deal => (
                    <div
                      key={deal.id}
                      className="card table-row-hover"
                      draggable
                      onClick={() => setSelectedDeal(deal)}
                      onDragStart={(e) => handleDragStart(e, deal.id)}
                      style={{ padding: '1.2rem', cursor: 'pointer', position: 'relative', display: 'flex', flexDirection: 'column', gap: '0.8rem', minWidth: 0, flexShrink: 0 }}
                    >
                      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', position: 'absolute', top: '0.75rem', right: '0.75rem' }}>
                        <button onClick={(e) => fetchAiScore(e, deal.id)} aria-label={`Generate deal score for ${deal.title}`} style={{ background: 'none', border: 'none', color: '#a855f7', cursor: 'pointer', padding: '0.25rem', display: 'flex' }} title="Generate AI Insights">
                          <Zap size={14} style={{transition: 'var(--transition)'}} onMouseOver={e => e.currentTarget.style.filter = 'drop-shadow(0 0 5px #a855f7)'} onMouseOut={e => e.currentTarget.style.filter = 'none'} />
                        </button>
                        <button onClick={(e) => handleDelete(e, deal.id)} aria-label={`Delete deal ${deal.title}`} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0.25rem', display: 'flex' }} title="Delete Deal">
                          <Trash2 size={14} style={{transition: 'var(--transition)'}} onMouseOver={e => e.currentTarget.style.color = '#ef4444'} onMouseOut={e => e.currentTarget.style.color = 'var(--text-secondary)'} />
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
                  ))}
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
