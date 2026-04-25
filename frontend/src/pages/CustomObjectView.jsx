import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Database, Plus, ArrowLeft, Download, Filter } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

export default function CustomObjectView() {
  const notify = useNotify();
  const { entityName } = useParams();
  const [entity, setEntity] = useState(null);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [formPayload, setFormPayload] = useState({});

  useEffect(() => { loadData(); }, [entityName]);

  const loadData = async () => {
    try {
      const data = await fetchApi(`/api/custom_objects/records/${entityName}`);
      setEntity(data.entity);
      setRecords(Array.isArray(data.records) ? data.records : []);
      
      // Initialize dynamic form state
      const initialForm = {};
      if (data.entity) {
        data.entity.fields.forEach(f => {
          initialForm[f.name] = f.type === 'Boolean' ? false : '';
        });
      }
      setFormPayload(initialForm);
      setLoading(false);
    } catch(err) { console.error(err); setLoading(false); }
  };

  const handleAddRecord = async (e) => {
    e.preventDefault();
    try {
      await fetchApi(`/api/custom_objects/records/${entityName}`, {
        method: 'POST',
        body: JSON.stringify(formPayload)
      });
      setShowAdd(false);
      loadData();
    } catch(err) { notify.error("Failed to log dynamic payload to EAV relational map."); }
  };

  if (loading) return <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Compiling metadata array matrix for {entityName}...</div>;
  if (!entity) return <div style={{ padding: '3rem', textAlign: 'center', color: '#ef4444' }}>Entity Schema "{entityName}" restricted or undefined.</div>;

  return (
    <div style={{ padding: '2rem', height: '100%', display: 'flex', flexDirection: 'column', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
          <Link to="/objects" style={{ color: 'var(--text-secondary)', textDecoration: 'none', background: 'var(--subtle-bg)', padding: '0.75rem', borderRadius: '8px', display: 'flex' }}>
            <ArrowLeft size={20} />
          </Link>
          <div>
            <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}><Database color="#ec4899" /> {entity.name}</h1>
            <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Dynamic Object View | {entity.description}</p>
          </div>
        </div>
        
        <div style={{ display: 'flex', gap: '1rem' }}>
          <button className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><Filter size={18}/> Filter Set</button>
          <button className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><Download size={18}/> Export CSV</button>
          <button onClick={() => setShowAdd(true)} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#ec4899', color: '#fff' }}>
            <Plus size={18} /> New {entity.name.slice(0, -1)}
          </button>
        </div>
      </header>

      <div className="card" style={{ flex: 1, overflow: 'auto', background: 'var(--table-header-bg)', padding: '0' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
          <thead>
            <tr style={{ background: 'var(--subtle-bg-2)', borderBottom: '1px solid var(--border-color)' }}>
              <th style={{ padding: '1rem 1.5rem', color: 'var(--text-secondary)', fontWeight: '600', fontSize: '0.875rem' }}>ID</th>
              {entity.fields.map(f => (
                <th key={f.id} style={{ padding: '1rem 1.5rem', color: 'var(--text-secondary)', fontWeight: '600', fontSize: '0.875rem' }}>
                  {f.name} <span style={{fontSize:'0.7rem', color:'#ec4899', marginLeft:'0.25rem', opacity:0.8}}>{f.type}</span>
                </th>
              ))}
              <th style={{ padding: '1rem 1.5rem', color: 'var(--text-secondary)', fontWeight: '600', fontSize: '0.875rem' }}>Created At</th>
            </tr>
          </thead>
          <tbody>
            {records.map(r => (
              <tr key={r.id} style={{ borderBottom: '1px solid var(--border-color)', transition: 'background 0.2s' }} onMouseOver={e=>e.currentTarget.style.background='var(--subtle-bg-2)'} onMouseOut={e=>e.currentTarget.style.background='transparent'}>
                <td style={{ padding: '1rem 1.5rem', fontSize: '0.875rem', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>EAV-{r.id}</td>
                {entity.fields.map(f => (
                  <td key={f.id} style={{ padding: '1rem 1.5rem', fontSize: '0.875rem' }}>
                    {f.type === 'Boolean' ? (r[f.name] ? 'True' : 'False') : String(r[f.name] || '—')}
                  </td>
                ))}
                <td style={{ padding: '1rem 1.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>{new Date(r.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
            {records.length === 0 && (
              <tr>
                <td colSpan={entity.fields.length + 2} style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No {entity.name} documented vertically.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(15, 23, 42, 0.9)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, animation: 'fadeIn 0.2s ease-out' }}>
          <div className="card" style={{ padding: '2.5rem', width: '500px', border: '1px solid rgba(236, 72, 153, 0.4)', boxShadow: '0 25px 50px rgba(0,0,0,0.8)' }}>
            <h3 style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <Plus size={24} color="#ec4899"/> Add New {entity.name.slice(0,-1)}
            </h3>
            <form onSubmit={handleAddRecord} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              
              {entity.fields.map(f => (
                <div key={f.id}>
                  <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>{f.name} <span style={{fontSize:'0.7rem', color:'#ec4899', float:'right'}}>{f.type}</span></label>
                  
                  {f.type === 'Boolean' ? (
                    <select className="input-field" value={formPayload[f.name]} onChange={e=>setFormPayload({...formPayload, [f.name]: e.target.value === 'true'})} style={{ background: 'var(--input-bg)' }}>
                      <option value="false">False</option>
                      <option value="true">True</option>
                    </select>
                  ) : f.type === 'Number' ? (
                    <input type="number" required className="input-field" value={formPayload[f.name]} onChange={e=>setFormPayload({...formPayload, [f.name]: e.target.value})} style={{ background: 'var(--input-bg)' }} />
                  ) : f.type === 'Date' ? (
                    <input type="date" required className="input-field" value={formPayload[f.name]} onChange={e=>setFormPayload({...formPayload, [f.name]: e.target.value})} style={{ background: 'var(--input-bg)' }} />
                  ) : (
                    <input type="text" required className="input-field" value={formPayload[f.name]} onChange={e=>setFormPayload({...formPayload, [f.name]: e.target.value})} style={{ background: 'var(--input-bg)' }} />
                  )}
                </div>
              ))}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '1rem' }}>
                <button type="button" onClick={()=>setShowAdd(false)} style={{ background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer' }}>Cancel</button>
                <button type="submit" className="btn-primary" style={{ background: '#ec4899', border: 'none', color: '#fff' }}>Insert Database Record</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
