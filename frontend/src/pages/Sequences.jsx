import React, { useState, useCallback, useEffect } from 'react';
import ReactFlow, { MiniMap, Controls, Background, addEdge, applyNodeChanges, applyEdgeChanges, Panel } from 'reactflow';
import 'reactflow/dist/style.css';
import { Network, Play, Plus, Save, Clock, Mail, Trash2, Users, RefreshCw } from 'lucide-react';
import { fetchApi } from '../utils/api';

const initialNodes = [
  { id: '1', type: 'input', data: { label: 'TRIGGER: Contact Subscribed' }, position: { x: 250, y: 50 }, style: { background: '#10b981', color: 'white', border: 'none', borderRadius: '8px', padding: '10px 20px', fontWeight: 'bold', width: 220, textAlign: 'center' } },
];

export default function Sequences() {
  const [nodes, setNodes] = useState(initialNodes);
  const [edges, setEdges] = useState([]);
  const [saving, setSaving] = useState(false);
  const [sequences, setSequences] = useState([]);
  const [activeSeqId, setActiveSeqId] = useState(null);
  const [seqName, setSeqName] = useState('');
  const [showNameModal, setShowNameModal] = useState(false);

  useEffect(() => { loadSequences(); }, []);

  const loadSequences = async () => {
    try {
      const data = await fetchApi('/api/sequences');
      setSequences(Array.isArray(data) ? data : []);
    } catch(err) {}
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
    setSaving(true);
    try {
      const name = nameOverride || seqName || `Drip Matrix ${Math.floor(Math.random()*9000)}`;
      if (activeSeqId) {
        // Update existing
        await fetchApi(`/api/sequences/${activeSeqId}`, {
          method: 'PATCH',
          body: JSON.stringify({ name, nodes, edges, isActive: true })
        });
      } else {
        await fetchApi('/api/sequences', {
          method: 'POST',
          body: JSON.stringify({ name, nodes, edges })
        });
      }
      setShowNameModal(false);
      setSeqName('');
      loadSequences();
    } catch(err) {
      console.error('Failed to save sequence:', err);
    }
    setSaving(false);
  };

  const deleteSequence = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm('Delete this sequence?')) return;
    try {
      await fetchApi(`/api/sequences/${id}`, { method: 'DELETE' });
      if (activeSeqId === id) {
        setNodes(initialNodes);
        setEdges([]);
        setActiveSeqId(null);
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
      <div style={{ flex: 1, minHeight: 0, border: '1px solid rgba(255,255,255,0.05)', borderRadius: '12px', overflow: 'hidden', background: '#0f172a', boxShadow: 'inset 0 0 30px rgba(0,0,0,0.8)', display: 'flex' }}>
        
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
            </Panel>
            <Background color="#1e293b" gap={24} size={2} />
            <Controls style={{ background: '#0f172a', fill: '#ec4899', border: '1px solid rgba(255,255,255,0.1)' }} />
            <MiniMap nodeStrokeColor="#ec4899" nodeColor="#1e293b" style={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)' }} />
          </ReactFlow>
        </div>

        {/* Existing Sequences Sidebar */}
        <div className="sequence-list card" style={{ flex: 1, minWidth: '220px', maxWidth: '280px', borderLeft: '1px solid rgba(255,255,255,0.05)', background: 'rgba(0,0,0,0.4)', padding: '1.5rem', overflowY: 'auto' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 'bold', marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#ec4899' }}>
            <Network size={18} /> Saved Sequences
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {sequences.map(seq => (
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
                  <span style={{
                    fontSize: '0.65rem', padding: '0.15rem 0.5rem',
                    background: seq.isActive ? 'rgba(16,185,129,0.2)' : 'rgba(255,255,255,0.1)',
                    color: seq.isActive ? '#10b981' : 'var(--text-secondary)',
                    borderRadius: '12px', fontWeight: 'bold'
                  }}>
                    {seq.isActive ? 'ACTIVE' : 'PAUSED'}
                  </span>
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
