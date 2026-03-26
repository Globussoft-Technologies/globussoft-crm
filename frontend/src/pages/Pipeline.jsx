import React, { useState, useEffect } from 'react';
import { Plus, Trash2 } from 'lucide-react';

const initialStages = [
  { id: 'lead', title: 'New Lead', color: 'var(--accent-color)' },
  { id: 'contacted', title: 'Contacted', color: 'var(--warning-color)' },
  { id: 'proposal', title: 'Proposal Sent', color: '#a855f7' },
  { id: 'won', title: 'Closed Won', color: 'var(--success-color)' }
];

const Pipeline = () => {
  const [deals, setDeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [newDeal, setNewDeal] = useState({ title: '', company: '', amount: '', probability: '', stage: 'lead' });

  const fetchDeals = () => {
    fetch('http://localhost:5000/api/deals')
      .then(res => res.json())
      .then(data => {
        setDeals(data);
        setLoading(false);
      })
      .catch(err => console.error(err));
  };

  useEffect(() => {
    fetchDeals();
  }, []);

  const handleAddDeal = async (e) => {
    e.preventDefault();
    await fetch('http://localhost:5000/api/deals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newDeal)
    });
    setShowModal(false);
    setNewDeal({ title: '', company: '', amount: '', probability: '', stage: 'lead' });
    fetchDeals();
  };

  const handleDelete = async (e, id) => {
    e.stopPropagation();
    if (window.confirm("Are you sure you want to delete this deal?")) {
      await fetch(`http://localhost:5000/api/deals/${id}`, { method: 'DELETE' });
      fetchDeals();
    }
  };

  return (
    <div style={{ padding: '2rem', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <header style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Sales Pipeline</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Track and manage active deals</p>
        </div>
        <button onClick={() => setShowModal(true)} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Plus size={18} /> Add Deal
        </button>
      </header>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '2rem' }}>Loading deals...</div>
      ) : (
        <div style={{ display: 'flex', gap: '1.5rem', flex: 1, overflowX: 'auto', paddingBottom: '1rem' }}>
          {initialStages.map(stage => {
            const stageDeals = deals.filter(d => d.stage === stage.id);
            const totalValue = stageDeals.reduce((sum, d) => sum + d.amount, 0);

            return (
              <div key={stage.id} className="glass" style={{ width: '300px', flexShrink: 0, borderRadius: '12px', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--surface-color)' }}>
                <div style={{ padding: '1rem', borderBottom: `2px solid ${stage.color}` }}>
                  <h3 style={{ fontSize: '1rem', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between' }}>
                    {stage.title}
                    <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>{stageDeals.length}</span>
                  </h3>
                  <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                    ${totalValue.toLocaleString()}
                  </p>
                </div>
                
                <div style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem', flex: 1, overflowY: 'auto' }}>
                  {stageDeals.map(deal => (
                    <div key={deal.id} className="card" style={{ padding: '1rem', cursor: 'pointer', position: 'relative' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <h4 style={{ fontWeight: '500', marginBottom: '0.5rem', paddingRight: '1rem' }}>{deal.title}</h4>
                        <button onClick={(e) => handleDelete(e, deal.id)} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', position: 'absolute', top: '0.75rem', right: '0.75rem' }}>
                          <Trash2 size={16} className="text-hover-red" />
                        </button>
                      </div>
                      <p style={{ fontSize: '1.25rem', fontWeight: 'bold', color: 'var(--text-primary)', marginBottom: '0.5rem' }}>
                        ${deal.amount.toLocaleString()}
                      </p>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{deal.company}</span>
                        <span style={{ fontSize: '0.75rem', padding: '0.15rem 0.5rem', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: '4px' }}>
                          {deal.probability}%
                        </span>
                      </div>
                    </div>
                  ))}
                  {stageDeals.length === 0 && (
                    <div style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.875rem', padding: '1rem' }}>
                      No deals in this stage
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ padding: '2rem', width: '400px' }}>
            <h3 style={{ marginBottom: '1.5rem', fontSize: '1.25rem', fontWeight: 'bold' }}>Add New Deal</h3>
            <form onSubmit={handleAddDeal} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <input type="text" placeholder="Deal Title" required className="input-field" value={newDeal.title} onChange={e => setNewDeal({...newDeal, title: e.target.value})} />
              <input type="text" placeholder="Company" required className="input-field" value={newDeal.company} onChange={e => setNewDeal({...newDeal, company: e.target.value})} />
              <input type="number" placeholder="Amount ($)" required className="input-field" value={newDeal.amount} onChange={e => setNewDeal({...newDeal, amount: e.target.value})} />
              <input type="number" placeholder="Probability (%)" required className="input-field" value={newDeal.probability} onChange={e => setNewDeal({...newDeal, probability: e.target.value})} />
              <select className="input-field" value={newDeal.stage} onChange={e => setNewDeal({...newDeal, stage: e.target.value})}>
                {initialStages.map(stage => (
                   <option key={stage.id} value={stage.id}>{stage.title}</option>
                ))}
              </select>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '1rem' }}>
                <button type="button" onClick={() => setShowModal(false)} style={{ background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer' }}>Cancel</button>
                <button type="submit" className="btn-primary">Save Deal</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default Pipeline;
