import React, { useState, useEffect } from 'react';

const initialStages = [
  { id: 'lead', title: 'New Lead', color: 'var(--accent-color)' },
  { id: 'contacted', title: 'Contacted', color: 'var(--warning-color)' },
  { id: 'proposal', title: 'Proposal Sent', color: '#a855f7' },
  { id: 'won', title: 'Closed Won', color: 'var(--success-color)' }
];

const Pipeline = () => {
  const [deals, setDeals] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('http://localhost:5000/api/deals')
      .then(res => res.json())
      .then(data => {
        setDeals(data);
        setLoading(false);
      })
      .catch(err => console.error(err));
  }, []);

  return (
    <div style={{ padding: '2rem', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <header style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Sales Pipeline</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Track and manage active deals</p>
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
                    <div key={deal.id} className="card" style={{ padding: '1rem', cursor: 'pointer' }}>
                      <h4 style={{ fontWeight: '500', marginBottom: '0.5rem' }}>{deal.title}</h4>
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
    </div>
  );
};

export default Pipeline;
