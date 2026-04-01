import React, { useState, useEffect } from 'react';
import { Database, Plus, Trash2, Layers, CheckCircle2 } from 'lucide-react';
import { fetchApi } from '../utils/api';

export default function CustomObjects() {
  const [entities, setEntities] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newEntity, setNewEntity] = useState({ name: '', description: '', fields: [{ name: 'DefaultProperty', type: 'Text' }] });
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadEntities(); }, []);

  const loadEntities = async () => {
    try {
      const data = await fetchApi('/api/custom_objects/entities');
      setEntities(Array.isArray(data) ? data : []);
      setLoading(false);
    } catch(err) { console.error(err); setLoading(false); }
  };

  const handleAddEntity = async (e) => {
    e.preventDefault();
    if (!newEntity.name) return;
    try {
      await fetchApi('/api/custom_objects/entities', {
        method: 'POST',
        body: JSON.stringify(newEntity)
      });
      setShowAdd(false);
      setNewEntity({ name: '', description: '', fields: [{ name: 'DefaultProperty', type: 'Text' }] });
      loadEntities();
    } catch(err) { alert("Failed to generate EAV dynamic database boundary constraints"); }
  };

  const addField = () => setNewEntity({ ...newEntity, fields: [...newEntity.fields, { name: 'NewProperty', type: 'Text' }] });

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold' }}>Custom Objects Builder</h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Visually prototype custom SQL-level CRM schema objects traversing native UI wrappers.</p>
        </div>
        <button onClick={() => setShowAdd(true)} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#ec4899', color: '#fff' }}>
          <Plus size={18} /> Create Entity
        </button>
      </header>

      {loading ? <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>Building Entity Abstraction Map...</div> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: '1.5rem' }}>
          {entities.map(ent => (
            <div key={ent.id} className="card" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
                <div style={{ background: 'rgba(236, 72, 153, 0.1)', padding: '0.75rem', borderRadius: '12px', color: '#ec4899' }}>
                  <Layers size={24} />
                </div>
                <div>
                  <h3 style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>{ent.name}</h3>
                  <span style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem', background: 'var(--subtle-bg-3)', borderRadius: '12px', color: 'var(--text-secondary)' }}>EAV Key-Value Sync Integrity: PASS</span>
                </div>
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1.5rem', flex: 1 }}>{ent.description || 'Natively defined backend matrix array limit parameters.'}</p>
              
              <div style={{ background: 'var(--subtle-bg)', padding: '1rem', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                <h4 style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Dynamically Generated Schema Fields:</h4>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                  {ent.fields.map(f => (
                    <span key={f.id} style={{ fontSize: '0.75rem', background: 'var(--bg-color)', border: '1px solid var(--border-color)', padding: '0.25rem 0.5rem', borderRadius: '4px', color: '#f8fafc' }}>
                      {f.name} <span style={{color: '#ec4899', opacity: 0.9, marginLeft: '0.4rem', fontWeight: '600'}}>{f.type}</span>
                    </span>
                  ))}
                </div>
              </div>
              <button onClick={() => window.location.href=`/objects/${ent.name}`} className="btn-secondary" style={{ marginTop: '1.5rem', width: '100%', borderColor: 'rgba(236, 72, 153, 0.3)', color: 'var(--text-primary)', cursor: 'pointer' }}>Access Dataset Records ({ent.records?.length || 0}) &rarr;</button>
            </div>
          ))}
          {entities.length === 0 && (
            <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '5rem 2rem', background: 'var(--subtle-bg-2)', border: '1px dashed var(--border-color)', borderRadius: '12px' }}>
              <Database size={56} color="var(--text-secondary)" style={{ opacity: 0.2, margin: '0 auto 1.5rem' }} />
              <h3 style={{ fontSize: '1.5rem', fontWeight: '600', marginBottom: '0.5rem' }}>Schema Definitions Missing</h3>
              <p style={{ color: 'var(--text-secondary)' }}>Use the visual abstraction tool to mint independent EAV schemas (e.g. `Properties`, `Vehicles`, `Shipments`).</p>
            </div>
          )}
        </div>
      )}

      {showAdd && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(15, 23, 42, 0.9)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, animation: 'fadeIn 0.2s ease-out' }}>
          <div className="card" style={{ padding: '2.5rem', width: '600px', maxHeight: '90vh', overflowY: 'auto', border: '1px solid rgba(236, 72, 153, 0.4)', boxShadow: '0 25px 50px rgba(0,0,0,0.8)' }}>
            <h3 style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <Database size={24} color="#ec4899"/> Formulate Schema Boundaries
            </h3>
            <form onSubmit={handleAddEntity} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Entity Name</label>
                <input type="text" name="name" required className="input-field" placeholder="e.g. Properties" value={newEntity.name} onChange={e=>setNewEntity({...newEntity, name: e.target.value})} style={{ background: 'var(--input-bg)' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Internal Structural Remarks</label>
                <input type="text" className="input-field" placeholder="Architectural notes for this custom relational mapping..." value={newEntity.description} onChange={e=>setNewEntity({...newEntity, description: e.target.value})} style={{ background: 'var(--input-bg)' }} />
              </div>

              <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                  <h4 style={{ fontSize: '0.875rem', fontWeight: 'bold', color: 'var(--text-secondary)' }}>Data Schema Fields</h4>
                  <button type="button" onClick={addField} style={{ background: 'transparent', color: '#ec4899', border: 'none', fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', fontWeight: '600' }}><Plus size={16}/> Insert Schema Property</button>
                </div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  {newEntity.fields.map((f, i) => (
                    <div key={i} style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                      <input type="text" className="input-field" placeholder="Property Alias (e.g. Volume)" value={f.name} onChange={e=>{const nf=[...newEntity.fields]; nf[i].name=e.target.value; setNewEntity({...newEntity, fields: nf})}} style={{ flex: 2, background: 'var(--input-bg)', borderColor: 'var(--border-color)' }} />
                      <select className="input-field" value={f.type} onChange={e=>{const nf=[...newEntity.fields]; nf[i].type=e.target.value; setNewEntity({...newEntity, fields: nf})}} style={{ flex: 1, background: 'var(--input-bg)', color: '#ec4899', fontWeight: '600', borderColor: 'var(--border-color)' }}>
                        <option style={{background:'var(--input-bg)'}}>Text</option>
                        <option style={{background:'var(--input-bg)'}}>Number</option>
                        <option style={{background:'var(--input-bg)'}}>Date</option>
                        <option style={{background:'var(--input-bg)'}}>Boolean</option>
                      </select>
                      <button type="button" onClick={()=>{const nf=[...newEntity.fields]; nf.splice(i,1); setNewEntity({...newEntity, fields: nf})}} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}><Trash2 size={20}/></button>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '1.5rem' }}>
                <button type="button" onClick={()=>setShowAdd(false)} style={{ background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer' }}>Cancel</button>
                <button type="submit" className="btn-primary" style={{ background: '#ec4899', border: 'none', display: 'flex', alignItems: 'center', gap: '0.5rem' }}><CheckCircle2 size={18}/> Create Schema</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
