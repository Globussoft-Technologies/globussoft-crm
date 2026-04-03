import React, { useState, useEffect } from 'react';
import { fetchApi } from '../utils/api';
import { Briefcase, ArrowRight, PlusCircle } from 'lucide-react';
import CPQBuilder from '../components/CPQBuilder';

export default function CPQ() {
  const [deals, setDeals] = useState([]);
  const [selectedDeal, setSelectedDeal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const loadDeals = async () => {
      try {
        const data = await fetchApi('/api/deals');
        setDeals(Array.isArray(data) ? data : []);
      } catch (err) {
        setError('Unable to load deals.');
      } finally {
        setLoading(false);
      }
    };
    loadDeals();
  }, []);

  return (
    <div style={{ padding: '2rem' }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Briefcase size={28} color="#8b5cf6" />
          <div>
            <h1 style={{ fontSize: '2rem', fontWeight: '700', color: 'var(--text-primary)' }}>Configure Price Quote</h1>
            <p style={{ color: 'var(--text-secondary)', maxWidth: '650px' }}>Select a sales deal and build CPQ quotes with a structured line-item schema that maps recurring and one-time SaaS pricing.</p>
          </div>
        </div>
      </header>

      <div style={{ display: 'grid', gap: '1.5rem', gridTemplateColumns: 'minmax(300px, 380px) minmax(0, 1fr)' }}>
        <div className="card" style={{ padding: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h2 style={{ fontSize: '1.1rem', fontWeight: '700', color: 'var(--text-primary)' }}>Deal Selection</h2>
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{deals.length} deals</span>
          </div>
          {loading ? (
            <div style={{ color: 'var(--text-secondary)', padding: '1rem' }}>Loading deals…</div>
          ) : error ? (
            <div style={{ color: '#ef4444', padding: '1rem' }}>{error}</div>
          ) : deals.length === 0 ? (
            <div style={{ color: 'var(--text-secondary)', padding: '1rem' }}>No deals available. Create a deal in the pipeline first.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {deals.map((deal) => (
                <button
                  key={deal.id}
                  onClick={() => setSelectedDeal(deal)}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    width: '100%',
                    padding: '0.95rem 1rem',
                    borderRadius: '12px',
                    background: selectedDeal?.id === deal.id ? 'rgba(59, 130, 246, 0.18)' : 'rgba(255,255,255,0.03)',
                    border: selectedDeal?.id === deal.id ? '1px solid rgba(59, 130, 246, 0.35)' : '1px solid rgba(255,255,255,0.06)',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    textAlign: 'left'
                  }}
                >
                  <div>
                    <div style={{ fontWeight: '700', marginBottom: '0.25rem' }}>{deal.title}</div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{deal.contact?.company || 'No contact linked'} · {deal.stage}</div>
                  </div>
                  <ArrowRight size={18} />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="card" style={{ padding: '1.5rem' }}>
          {selectedDeal ? (
            <CPQBuilder dealId={selectedDeal.id} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '1rem', minHeight: '320px', justifyContent: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <PlusCircle size={28} color="#8b5cf6" />
                <div>
                  <h2 style={{ fontSize: '1.2rem', fontWeight: '700', color: 'var(--text-primary)' }}>No deal selected</h2>
                  <p style={{ color: 'var(--text-secondary)' }}>Choose a deal from the left panel to work in the CPQ builder.</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
