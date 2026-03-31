import React, { useState, useCallback, useEffect } from 'react';
import ReactFlow, { MiniMap, Controls, Background, addEdge, applyNodeChanges, applyEdgeChanges, Panel } from 'reactflow';
import 'reactflow/dist/style.css';
import { Network, Play, Plus, Save, Clock, Mail } from 'lucide-react';
import { fetchApi } from '../utils/api';

const initialNodes = [
  { id: '1', type: 'input', data: { label: 'TRIGGER: Contact Subscribed' }, position: { x: 250, y: 50 }, style: { background: '#10b981', color: 'white', border: 'none', borderRadius: '8px', padding: '10px 20px', fontWeight: 'bold', width: 220, textAlign: 'center' } },
];

export default function Sequences() {
  const [nodes, setNodes] = useState(initialNodes);
  const [edges, setEdges] = useState([]);
  const [saving, setSaving] = useState(false);
  const [sequences, setSequences] = useState([]);

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

  const saveSequence = async () => {
    setSaving(true);
    try {
      await fetchApi('/api/sequences', {
        method: 'POST',
        body: JSON.stringify({ name: `Drip Matrix ${Math.floor(Math.random()*9000)}`, nodes, edges })
      });
      alert('Marketing Sequence Activated Successfully against Node-Cron engine.');
      loadSequences();
    } catch(err) { alert("Failed to secure Sequence Graph constraint."); }
    setSaving(false);
  };

  return (
    <div style={{ padding: '2rem', height: '100%', display: 'flex', flexDirection: 'column', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
         <div>
           <h1 style={{ fontSize: '2rem', fontWeight: 'bold' }}>Marketing Automated Sequences</h1>
           <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Visual Drip Campaign array mapping utilizing CRON step execution loops.</p>
         </div>
         <button onClick={saveSequence} disabled={saving} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#ec4899', border: 'none' }}>
           <Save size={18} /> {saving ? 'Compiling Graphs...' : 'Create Sequence'}
         </button>
      </header>

      {/* Adding minHeight: 0 to prevent flexbox boundary explosion that clips the React Flow layer */}
      <div style={{ flex: 1, minHeight: 0, border: '1px solid rgba(255,255,255,0.05)', borderRadius: '12px', overflow: 'hidden', background: '#0f172a', boxShadow: 'inset 0 0 30px rgba(0,0,0,0.8)', display: 'flex' }}>
        
        {/* ReactFlow Graph Canvas */}
        <div style={{ flex: 3, position: 'relative' }}>
          <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} fitView theme="dark">
            <Panel position="top-left" style={{ display: 'flex', gap: '1rem', background: 'rgba(0,0,0,0.8)', padding: '0.75rem', borderRadius: '8px', backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.05)' }}>
              <button onClick={() => addLogicNode('default', 'ACTION: Dispatch Template Email', '#3b82f6')} className="btn-secondary" style={{ fontSize: '0.85rem', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', borderColor: 'rgba(59, 130, 246, 0.4)' }}><Mail size={16} color="#3b82f6"/> Add Email Vector</button>
              <button onClick={() => addLogicNode('default', 'DELAY: Traverse 72 Hours', '#f59e0b')} className="btn-secondary" style={{ fontSize: '0.85rem', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', borderColor: 'rgba(245, 158, 11, 0.4)' }}><Clock size={16} color="#f59e0b"/> Add Time Delay Node</button>
            </Panel>
            <Background color="#1e293b" gap={24} size={2} />
            <Controls style={{ background: '#0f172a', fill: '#ec4899', border: '1px solid rgba(255,255,255,0.1)' }} />
          </ReactFlow>
        </div>

        {/* Existing Sequences Sidebar */}
        <div className="sequence-list card" style={{ flex: 1, borderLeft: '1px solid rgba(255,255,255,0.05)', background: 'rgba(0,0,0,0.4)', padding: '1.5rem', overflowY: 'auto' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: 'bold', marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#ec4899' }}><Network size={20} /> Mounted Matrices</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {sequences.map(seq => (
              <div key={seq.id} style={{ background: 'rgba(255,255,255,0.02)', padding: '1.25rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                  <h4 style={{ fontWeight: '600', fontSize: '1rem' }}>{seq.name}</h4>
                  <span style={{ fontSize: '0.7rem', padding: '0.2rem 0.6rem', background: seq.isActive ? 'rgba(16, 185, 129, 0.2)' : 'rgba(255,255,255,0.1)', color: seq.isActive ? '#10b981' : 'var(--text-secondary)', borderRadius: '12px', fontWeight: 'bold', letterSpacing: '0.05em' }}>{seq.isActive ? 'RUNNING' : 'PAUSED'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  <span style={{display: 'flex', alignItems: 'center', gap: '0.25rem'}}><Network size={14}/> {JSON.parse(seq.nodes || '[]').length} Graph Nodes</span>
                  <span style={{display: 'flex', alignItems: 'center', gap: '0.25rem'}}><Play size={14}/> {seq._count?.enrollments || 0} Enrolled Contacts</span>
                </div>
              </div>
            ))}
            {sequences.length === 0 && (
              <div style={{ textAlign: 'center', padding: '3rem 1rem', opacity: 0.5 }}>
                 <Clock size={32} style={{ margin: '0 auto 1rem', color: 'var(--text-secondary)' }} />
                 <p style={{ color: 'var(--text-secondary)' }}>No automated sequence schedules deployed.</p>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
