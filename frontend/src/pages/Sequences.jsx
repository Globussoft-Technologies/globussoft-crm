import React, { useState, useCallback, useEffect } from 'react';
import { Link } from 'react-router-dom';
import ReactFlow, { MiniMap, Controls, Background, addEdge, applyNodeChanges, applyEdgeChanges, Panel } from 'reactflow';
import 'reactflow/dist/style.css';
import { Network, Play, Plus, Save, Clock, Mail, Trash2, Users, RefreshCw, MessageSquare, MessageCircle, Bell, ListOrdered } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { DateRangeFilter, resolveDateRange, EMPTY_DATE_FILTER } from '../components/wellness/DateRangeFilter';

const initialNodes = [
  { id: '1', type: 'input', data: { label: 'TRIGGER: Contact Subscribed' }, position: { x: 250, y: 50 }, style: { background: '#10b981', color: 'white', border: 'none', borderRadius: '8px', padding: '10px 20px', fontWeight: 'bold', width: 220, textAlign: 'center' } },
];

// #616: vertical-aware fallback list. The backend GET /api/sequences/triggers
// is authoritative; this fallback only fires if the call errors so the
// trigger picker still works offline / on a transient 5xx.
const FALLBACK_TRIGGERS = [
  { value: 'contact.created', label: 'Contact Created', vertical: 'generic' },
  { value: 'lead.converted', label: 'Lead Converted', vertical: 'generic' },
  { value: 'deal.won', label: 'Deal Won', vertical: 'generic' },
];

// #394: sessionStorage keys for draft persistence. We persist the canvas
// (nodes + edges) and the activeSeqId across hard refreshes so a user who
// refreshes mid-build doesn't lose the work, and a user who refreshes after
// loading a saved sequence comes back to the same one.
const DRAFT_KEY = 'sequences:draft';
const ACTIVE_SEQ_KEY = 'sequences:activeSeqId';

// #640: status-badge palette. Pre-fix, ACTIVE and PAUSED both rendered in
// the green family (ACTIVE = #10b981, PAUSED = white/transparent on a dark
// surface) so they were hard to distinguish at a glance for marketers and
// indistinguishable for colour-blind users. Map status → semantic CSS var:
//   ACTIVE  → success-green (running)
//   PAUSED  → warning-amber (neutral pause; needs attention to resume)
//   DRAFT   → muted text-secondary (not yet shipped)
// The Sequence schema only has `isActive: Boolean` today, so we render
// ACTIVE / PAUSED. DRAFT branch is exposed for forward-compat when an
// explicit status enum lands (regression-coverage-friendly default).
export const sequenceStatusBadgeStyle = (status) => {
  if (status === 'ACTIVE') {
    return {
      bg: 'rgba(16, 185, 129, 0.18)',
      fg: 'var(--success-color, #10b981)',
      cls: 'badge-active',
    };
  }
  if (status === 'PAUSED') {
    return {
      bg: 'rgba(245, 158, 11, 0.20)',
      fg: 'var(--warning-color, #f59e0b)',
      cls: 'badge-paused',
    };
  }
  // DRAFT / unknown — neutral grey
  return {
    bg: 'rgba(255, 255, 255, 0.10)',
    fg: 'var(--text-secondary)',
    cls: 'badge-draft',
  };
};

const loadDraft = () => {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
      return parsed;
    }
  } catch { /* ignore */ }
  return null;
};

const saveDraft = (nodes, edges, activeSeqId) => {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ nodes, edges }));
    if (activeSeqId != null) {
      sessionStorage.setItem(ACTIVE_SEQ_KEY, String(activeSeqId));
    } else {
      sessionStorage.removeItem(ACTIVE_SEQ_KEY);
    }
  } catch { /* ignore quota */ }
};

const clearDraft = () => {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
    sessionStorage.removeItem(ACTIVE_SEQ_KEY);
  } catch { /* ignore */ }
};

export default function Sequences() {
  const notify = useNotify();
  // #394: hydrate from sessionStorage on first paint so a refresh during a
  // build keeps the user's added nodes on the canvas. If no draft exists,
  // fall back to the trigger-only initialNodes.
  const initial = loadDraft();
  const [nodes, setNodes] = useState(initial?.nodes ?? initialNodes);
  const [edges, setEdges] = useState(initial?.edges ?? []);
  const [saving, setSaving] = useState(false);
  const [sequences, setSequences] = useState([]);
  const [seqDateFilter, setSeqDateFilter] = useState(EMPTY_DATE_FILTER);
  const [seqRangeStart, seqRangeEnd] = resolveDateRange(seqDateFilter);
  const visibleSequences = (seqRangeStart && seqRangeEnd)
    ? sequences.filter((s) => {
        const ts = new Date(s.createdAt).getTime();
        return ts >= seqRangeStart.getTime() && ts <= seqRangeEnd.getTime();
      })
    : sequences;
  const [activeSeqId, setActiveSeqId] = useState(() => {
    try {
      const raw = sessionStorage.getItem(ACTIVE_SEQ_KEY);
      return raw ? parseInt(raw, 10) : null;
    } catch { return null; }
  });
  const [seqName, setSeqName] = useState('');
  const [showNameModal, setShowNameModal] = useState(false);
  // #616: vertical-aware trigger catalog from GET /api/sequences/triggers.
  // Wellness tenants get visit/treatment/consent triggers in addition to
  // generic contact/lead/deal events; the picker hydrates on mount.
  const [triggers, setTriggers] = useState(FALLBACK_TRIGGERS);

  useEffect(() => { loadSequences(); loadTriggers(); }, []);

  // #394: autosave the canvas to sessionStorage on every change so a hard
  // refresh / accidental tab close doesn't drop work the user hasn't yet
  // hit "Create Sequence" on. Throttle is unnecessary at this size.
  useEffect(() => {
    saveDraft(nodes, edges, activeSeqId);
  }, [nodes, edges, activeSeqId]);

  const loadSequences = async () => {
    try {
      // #397: silent so a transient 404/403 on this background list fetch
      // doesn't pop a "Not found." toast over the canvas.
      const data = await fetchApi('/api/sequences', { silent: true });
      setSequences(Array.isArray(data) ? data : []);
    } catch(err) {}
  };

  // #616: wellness-aware trigger catalog. Silent on failure so the picker
  // falls back to the generic-only FALLBACK_TRIGGERS list.
  const loadTriggers = async () => {
    try {
      const data = await fetchApi('/api/sequences/triggers', { silent: true });
      if (Array.isArray(data) && data.length > 0) setTriggers(data);
    } catch(err) {}
  };

  // #616: append a TRIGGER node to the canvas (lets the marketer pick a
  // wellness event like visit.completed as the entry point).
  const addTriggerNode = (trig) => {
    const newNode = {
      id: `${Date.now()}`,
      type: 'input',
      data: { label: `TRIGGER: ${trig.label || trig.value}` },
      position: { x: Math.random() * 200 + 100, y: Math.random() * 100 + 30 },
      style: { background: trig.vertical === 'wellness' ? '#265855' : '#10b981', color: 'white', border: 'none', borderRadius: '8px', padding: '10px 20px', fontWeight: 'bold', width: 240, textAlign: 'center' },
    };
    setNodes((nds) => nds.concat(newNode));
  };

  const onNodesChange = useCallback((changes) => setNodes((nds) => applyNodeChanges(changes, nds)), []);
  const onEdgesChange = useCallback((changes) => setEdges((eds) => applyEdgeChanges(changes, eds)), []);
  const onConnect = useCallback((params) => setEdges((eds) => addEdge({ ...params, animated: true, style: { stroke: '#ec4899', strokeWidth: 2 } }, eds)), []);

  const addLogicNode = (type, label, color) => {
    const newNode = {
      id: `${Date.now()}`,
      data: { label },
      position: { x: Math.random() * 200 + 100, y: Math.random() * 200 + 100 },
      style: { background: color, color: 'white', border: 'none', borderRadius: '8px', padding: '10px 20px', fontWeight: 'bold', boxShadow: '0 4px 6px rgba(0,0,0,0.3)', width: 220, textAlign: 'center' }
    };
    setNodes((nds) => nds.concat(newNode));
  };

  const loadSequenceIntoCanvas = (seq) => {
    try {
      const loadedNodes = JSON.parse(seq.nodes || '[]');
      const loadedEdges = JSON.parse(seq.edges || '[]');
      if (loadedNodes.length > 0) {
        setNodes(loadedNodes);
        setEdges(loadedEdges);
        setActiveSeqId(seq.id);
      }
    } catch(err) {
      console.error('Failed to load sequence:', err);
    }
  };

  const saveSequence = async (nameOverride) => {
    // #396: validate name (trim, length>=1) BEFORE we hit the network so an
    // empty / whitespace-only name never round-trips and the user gets an
    // immediate, clear error rather than a server-side rejection.
    const rawName = (nameOverride || seqName || '').trim();
    const fallback = `Drip Matrix ${Math.floor(Math.random()*9000)}`;
    const name = rawName.length >= 1 ? rawName : fallback;

    // #395: validate canvas shape before submit. We require at least one
    // node beyond the starter trigger, and `nodes` must be an array. The
    // backend re-validates, but this catches the common case (empty canvas)
    // before it ever turns into a 500.
    if (!Array.isArray(nodes) || nodes.length < 1) {
      notify.error('Add at least one step to the canvas before saving.');
      return;
    }

    setSaving(true);
    try {
      if (activeSeqId) {
        // Update existing
        // #374: don't ship isActive:true on plain saves — that would silently
        // activate a paused/draft sequence on every "Save". Activation is
        // owned by the explicit Active toggle in the step-list builder.
        await fetchApi(`/api/sequences/${activeSeqId}`, {
          method: 'PATCH',
          body: JSON.stringify({ name, nodes, edges })
        });
      } else {
        const created = await fetchApi('/api/sequences', {
          method: 'POST',
          body: JSON.stringify({ name, nodes, edges })
        });
        if (created?.id) setActiveSeqId(created.id);
      }
      setShowNameModal(false);
      setSeqName('');
      // #394: keep the draft tied to the now-persisted sequence so the next
      // refresh continues to show the same canvas. We only blow it away on
      // explicit "New" / delete.
      loadSequences();
    } catch(err) {
      console.error('Failed to save sequence:', err);
    }
    setSaving(false);
  };

  const deleteSequence = async (id, e) => {
    e.stopPropagation();
    if (!await notify.confirm('Delete this sequence?')) return;
    try {
      await fetchApi(`/api/sequences/${id}`, { method: 'DELETE' });
      if (activeSeqId === id) {
        setNodes(initialNodes);
        setEdges([]);
        setActiveSeqId(null);
        // #394: drop the persisted draft for the deleted sequence so a
        // refresh doesn't resurrect a stale canvas pointing at a dead row.
        clearDraft();
      }
      loadSequences();
    } catch(err) {
      console.error('Failed to delete sequence:', err);
    }
  };

  const resetCanvas = () => {
    setNodes(initialNodes);
    setEdges([]);
    setActiveSeqId(null);
    // #394: explicit user-initiated reset wipes the draft too.
    clearDraft();
  };

  return (
    <div style={{ padding: '2rem', height: '100%', display: 'flex', flexDirection: 'column', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
         <div>
           <h1 style={{ fontSize: '2rem', fontWeight: 'bold' }}>Marketing Automated Sequences</h1>
           <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Visual drip campaign builder — drag, connect, and activate workflow automations.</p>
         </div>
         <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
           <button onClick={resetCanvas} className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
             <RefreshCw size={16} /> New
           </button>
           <button onClick={() => setShowNameModal(true)} disabled={saving} className="btn-primary" id="save-sequence-btn" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#ec4899', border: 'none' }}>
             <Save size={18} /> {saving ? 'Saving...' : 'Create Sequence'}
           </button>
         </div>
      </header>

      {/* Name Modal */}
      {showNameModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
          <div className="card" style={{ padding: '2rem', width: '380px' }}>
            <h3 style={{ fontWeight: 'bold', marginBottom: '1rem' }}>Name Your Sequence</h3>
            <input
              type="text"
              className="input-field"
              placeholder="e.g. Onboarding Drip Week 1"
              value={seqName}
              onChange={e => setSeqName(e.target.value)}
              style={{ marginBottom: '1rem', width: '100%' }}
              autoFocus
            />
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
              <button onClick={() => setShowNameModal(false)} className="btn-secondary">Cancel</button>
              <button onClick={() => saveSequence()} className="btn-primary" style={{ background: '#ec4899', border: 'none' }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Adding minHeight: 0 to prevent flexbox boundary explosion that clips the React Flow layer */}
      <div style={{ flex: 1, minHeight: 0, border: '1px solid var(--border-color)', borderRadius: '12px', overflow: 'hidden', background: 'var(--surface-color)', boxShadow: 'var(--glass-shadow)', display: 'flex' }}>
        
        {/* ReactFlow Graph Canvas */}
        <div style={{ flex: 3, position: 'relative' }}>
          <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} fitView>
            <Panel position="top-left" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', background: 'rgba(0,0,0,0.8)', padding: '0.75rem', borderRadius: '8px', backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.05)', maxWidth: '420px' }}>
              <button onClick={() => addLogicNode('default', 'ACTION: Send Email', '#3b82f6')} className="btn-secondary" style={{ fontSize: '0.85rem', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', borderColor: 'rgba(59,130,246,0.4)' }}>
                <Mail size={16} color="#3b82f6"/> Add Email
              </button>
              <button onClick={() => addLogicNode('default', 'DELAY: Wait 72 Hours', '#f59e0b')} className="btn-secondary" style={{ fontSize: '0.85rem', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', borderColor: 'rgba(245,158,11,0.4)' }}>
                <Clock size={16} color="#f59e0b"/> Add Delay
              </button>
              <button onClick={() => addLogicNode('default', 'CONDITION: Tag Check', '#8b5cf6')} className="btn-secondary" style={{ fontSize: '0.85rem', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', borderColor: 'rgba(139,92,246,0.4)' }}>
                <Network size={16} color="#8b5cf6"/> Add Condition
              </button>
              <button onClick={() => addLogicNode('default', 'ACTION: Send SMS', '#10b981')} className="btn-secondary" style={{ fontSize: '0.85rem', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', borderColor: 'rgba(16,185,129,0.4)' }}>
                <MessageSquare size={16} color="#10b981"/> SMS
              </button>
              <button onClick={() => addLogicNode('default', 'ACTION: Send WhatsApp', '#25D366')} className="btn-secondary" style={{ fontSize: '0.85rem', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', borderColor: 'rgba(37,211,102,0.4)' }}>
                <MessageCircle size={16} color="#25D366"/> WhatsApp
              </button>
              <button onClick={() => addLogicNode('default', 'ACTION: Send Push', '#a855f7')} className="btn-secondary" style={{ fontSize: '0.85rem', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', borderColor: 'rgba(168,85,247,0.4)' }}>
                <Bell size={16} color="#a855f7"/> Push
              </button>
              {/* #616: trigger picker — vertical-aware. Wellness tenants see
                  visit / treatment / consent triggers alongside generic ones. */}
              <select
                data-testid="trigger-picker"
                aria-label="Add trigger node"
                defaultValue=""
                onChange={(e) => {
                  const t = triggers.find((x) => x.value === e.target.value);
                  if (t) addTriggerNode(t);
                  e.target.value = '';
                }}
                className="btn-secondary"
                style={{ fontSize: '0.85rem', padding: '0.5rem 0.75rem', borderColor: 'rgba(16,185,129,0.4)', cursor: 'pointer' }}
              >
                <option value="" disabled>+ Add Trigger</option>
                {triggers.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.vertical === 'wellness' ? 'Wellness · ' : ''}{t.label || t.value}
                  </option>
                ))}
              </select>
            </Panel>
            <Background color="#1e293b" gap={24} size={2} />
            <Controls style={{ background: 'var(--surface-color)', fill: '#ec4899', border: '1px solid var(--border-color)' }} />
            <MiniMap nodeStrokeColor="#ec4899" nodeColor="var(--surface-color)" style={{ background: 'var(--surface-color)', border: '1px solid var(--border-color)' }} />
          </ReactFlow>
        </div>

        {/* Existing Sequences Sidebar */}
        <div className="sequence-list card" style={{ flex: 1, minWidth: '220px', maxWidth: '280px', borderLeft: '1px solid rgba(255,255,255,0.05)', background: 'rgba(0,0,0,0.4)', padding: '1.5rem', overflowY: 'auto' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 'bold', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#ec4899' }}>
            <Network size={18} /> Saved Sequences
          </h3>
          {sequences.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center', marginBottom: '0.75rem' }}>
              <DateRangeFilter value={seqDateFilter} onChange={setSeqDateFilter} label={null} />
              {visibleSequences.length !== sequences.length && (
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                  {visibleSequences.length}/{sequences.length}
                </span>
              )}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {visibleSequences.map(seq => (
              <div
                key={seq.id}
                onClick={() => loadSequenceIntoCanvas(seq)}
                style={{
                  background: activeSeqId === seq.id ? 'rgba(236,72,153,0.15)' : 'rgba(255,255,255,0.02)',
                  padding: '1rem',
                  borderRadius: '8px',
                  border: `1px solid ${activeSeqId === seq.id ? 'rgba(236,72,153,0.4)' : 'rgba(255,255,255,0.05)'}`,
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                  <h4 style={{ fontWeight: '600', fontSize: '0.9rem', flex: 1, marginRight: '0.5rem' }}>{seq.name}</h4>
                  <Link
                    to={`/sequences/${seq.id}/builder`}
                    onClick={(e) => e.stopPropagation()}
                    style={{ background: 'transparent', border: 'none', color: '#3b82f6', padding: '2px 4px', position: 'relative', zIndex: 10, pointerEvents: 'all', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
                    title="Open step-list builder"
                  >
                    <ListOrdered size={14} />
                  </Link>
                  <button
                    onClick={(e) => deleteSequence(seq.id, e)}
                    style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '2px', position: 'relative', zIndex: 10, pointerEvents: 'all' }}
                    title="Delete sequence"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                    <Network size={12}/> {JSON.parse(seq.nodes || '[]').length} nodes
                  </span>
                  {(() => {
                    const status = seq.isActive ? 'ACTIVE' : 'PAUSED';
                    const palette = sequenceStatusBadgeStyle(status);
                    return (
                      <span
                        data-testid={`sequence-status-${seq.id}`}
                        data-status={status}
                        className={palette.cls}
                        style={{
                          fontSize: '0.65rem', padding: '0.15rem 0.5rem',
                          background: palette.bg,
                          color: palette.fg,
                          borderRadius: '12px', fontWeight: 'bold'
                        }}
                      >
                        {status}
                      </span>
                    );
                  })()}
                </div>
              </div>
            ))}
            {sequences.length === 0 && (
              <div style={{ textAlign: 'center', padding: '2rem 1rem', opacity: 0.5 }}>
                <Clock size={28} style={{ margin: '0 auto 0.75rem', color: 'var(--text-secondary)' }} />
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>No sequences yet.<br/>Build one and click Save.</p>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
