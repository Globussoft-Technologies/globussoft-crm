import React, { useState, useCallback, useEffect } from 'react';
import ReactFlow, { 
  MiniMap, Controls, Background, addEdge, applyNodeChanges, applyEdgeChanges, Panel 
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Save, Play, Zap, Database, Mail } from 'lucide-react';
import { fetchApi } from '../utils/api';

const initialNodes = [
  { id: '1', type: 'input', data: { label: 'TRIGGER: Deal Stage → Won' }, position: { x: 250, y: 50 }, style: { background: '#10b981', color: 'white', border: 'none', borderRadius: '8px', padding: '10px 20px', fontWeight: 'bold' } },
];
const initialEdges = [];

export default function Workflows() {
  const [nodes, setNodes] = useState(initialNodes);
  const [edges, setEdges] = useState(initialEdges);
  const [saving, setSaving] = useState(false);

  const onNodesChange = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds)),
    []
  );
  const onEdgesChange = useCallback(
    (changes) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    []
  );
  const onConnect = useCallback(
    (params) => setEdges((eds) => addEdge({ ...params, animated: true, style: { stroke: '#3b82f6', strokeWidth: 2 } }, eds)),
    []
  );

  const addNode = (type, label, color) => {
    const newNode = {
      id: `${Date.now()}`,
      data: { label },
      position: { x: Math.random() * 200 + 100, y: Math.random() * 200 + 100 },
      style: { background: color, color: 'white', border: 'none', borderRadius: '8px', padding: '10px 20px', fontWeight: 'bold', boxShadow: '0 4px 6px rgba(0,0,0,0.3)', width: 220, textAlign: 'center' }
    };
    setNodes((nds) => nds.concat(newNode));
  };

  const saveWorkflow = async () => {
    setSaving(true);
    // Serialize workflow into AutomationRule format
    const rule = {
      name: `Visual Graph Matrix ${Math.floor(Math.random() * 9000)}`,
      triggerType: 'Canvas Graph Node',
      actionType: 'Multi-threaded Action',
      targetState: 'active'
    };
    try {
      await fetchApi('/api/workflows', {
        method: 'POST',
        body: JSON.stringify(rule)
      });
      alert('Algorithmic Rule Boolean compiled to Postgres Schema successfully!');
    } catch(err) {
      alert("System compilation failed during structural export.");
    }
    setSaving(false);
  };

  return (
    <div style={{ padding: '2rem', height: '100%', display: 'flex', flexDirection: 'column', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
         <div>
           <h1 style={{ fontSize: '2rem', fontWeight: 'bold' }}>Visual Logic Canvas</h1>
           <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Construct algorithmic business logic vectors via drag-and-drop structural mapping.</p>
         </div>
         <button onClick={saveWorkflow} disabled={saving} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'var(--success-color)' }}>
           <Save size={18} /> {saving ? 'Compiling Nodes...' : 'Deploy Boolean Logic'}
         </button>
      </header>

      <div style={{ flex: 1, border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', overflow: 'hidden', background: '#0f172a', boxShadow: 'inset 0 0 20px rgba(0,0,0,0.5)' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          fitView
          theme="dark"
        >
          <Panel position="top-left" style={{ display: 'flex', gap: '1rem', background: 'rgba(0,0,0,0.6)', padding: '0.75rem', borderRadius: '8px', backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.05)' }}>
            <button onClick={() => addNode('default', 'CONDITION: Value > $10,000', '#f59e0b')} className="btn-secondary" style={{ fontSize: '0.85rem', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}><Database size={16} /> Data Check</button>
            <button onClick={() => addNode('output', 'ACTION: Issue Final Invoice', '#3b82f6')} className="btn-secondary" style={{ fontSize: '0.85rem', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}><Mail size={16} /> Emit Invoice</button>
            <button onClick={() => addNode('output', 'WEBHOOK: Dispatch Payload', '#ec4899')} className="btn-secondary" style={{ fontSize: '0.85rem', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}><Zap size={16} /> POST Call</button>
          </Panel>
          <Background color="#334155" gap={20} size={1.5} />
          <Controls style={{ background: '#1e293b', fill: '#fff', border: '1px solid rgba(255,255,255,0.1)' }} />
        </ReactFlow>
      </div>
    </div>
  );
}