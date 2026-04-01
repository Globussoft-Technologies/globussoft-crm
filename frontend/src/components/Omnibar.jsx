import React, { useState, useEffect, useRef } from 'react';
import { Search, User, Briefcase, FileText, X } from 'lucide-react';
import { fetchApi } from '../utils/api';

export default function Omnibar() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState({ contacts: [], deals: [], invoices: [] });
  const [isLoading, setIsLoading] = useState(false);
  
  const inputRef = useRef(null);

  useEffect(() => {
    const handleKeyDown = (e) => {
      // Toggle on Ctrl+K or Cmd+K
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
      if (e.key === 'Escape') setIsOpen(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    const fetchOmni = async () => {
      if (query.length < 2) {
        setResults({ contacts: [], deals: [], invoices: [] });
        return;
      }
      setIsLoading(true);
      try {
        const data = await fetchApi(`/api/search?q=${encodeURIComponent(query)}`);
        setResults(data);
      } catch(err) {
        console.error(err);
      }
      setIsLoading(false);
    };

    const debounce = setTimeout(fetchOmni, 300);
    return () => clearTimeout(debounce);
  }, [query]);

  if (!isOpen) return null;

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'var(--overlay-bg)', backdropFilter: 'blur(8px)', zIndex: 9999, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '10vh', animation: 'fadeIn 0.2s ease-out' }}>
      <div className="card" style={{ width: '100%', maxWidth: '650px', background: 'var(--surface-color)', border: '1px solid var(--border-color)', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.8), 0 0 40px rgba(59, 130, 246, 0.1)', overflow: 'hidden', borderRadius: '12px' }}>
        
        <div style={{ display: 'flex', alignItems: 'center', padding: '1rem 1.5rem', borderBottom: '1px solid var(--border-color)' }}>
          <Search size={24} color="var(--accent-color)" />
          <input ref={inputRef} type="text" placeholder="Omnisearch Contacts, Pipelines, or Invoices..." value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: 1, background: 'transparent', border: 'none', color: 'var(--text-primary)', fontSize: '1.25rem', padding: '0 1rem', outline: 'none' }} />
          <button onClick={() => setIsOpen(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0.25rem' }} onMouseOver={e=>e.currentTarget.style.color='var(--text-primary)'} onMouseOut={e=>e.currentTarget.style.color='var(--text-secondary)'}><X size={20} /></button>
        </div>

        <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {isLoading && <div style={{ padding: '3rem 2rem', textAlign: 'center', color: 'var(--accent-color)', animation: 'pulse 1.5s infinite' }}>Scanning Global Grid...</div>}
          
          {!isLoading && query.length >= 2 && results.contacts.length === 0 && results.deals.length === 0 && results.invoices.length === 0 && (
            <div style={{ padding: '4rem 2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No algorithmic matches located for "<span style={{color: 'var(--text-primary)'}}>{query}</span>" within the enterprise dataset.</div>
          )}

          {!isLoading && (
            <div style={{ padding: '0.5rem' }}>
              {/* Contacts */}
              {results.contacts.length > 0 && (
                <div style={{ marginBottom: '0.5rem' }}>
                  <h4 style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', padding: '0.5rem 1rem' }}>Address Book</h4>
                  {results.contacts.map(c => (
                    <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.75rem 1rem', cursor: 'pointer', borderRadius: '8px', transition: 'background 0.2s' }} onMouseOver={e => e.currentTarget.style.background = 'var(--subtle-bg)'} onMouseOut={e => e.currentTarget.style.background = 'transparent'} onClick={() => setIsOpen(false)}>
                      <div style={{ background: 'rgba(59, 130, 246, 0.1)', padding: '0.5rem', borderRadius: '8px', border: '1px solid rgba(59, 130, 246, 0.2)' }}><User size={18} color="#3b82f6" /></div>
                      <div><div style={{ fontWeight: '500', color: 'var(--text-primary)' }}>{c.name} {c.company && `• ${c.company}`}</div><div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>{c.email}</div></div>
                    </div>
                  ))}
                </div>
              )}
              
              {/* Deals */}
              {results.deals.length > 0 && (
                <div style={{ marginBottom: '0.5rem' }}>
                  <h4 style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', padding: '0.5rem 1rem' }}>Pipeline Extracted</h4>
                  {results.deals.map(d => (
                    <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.75rem 1rem', cursor: 'pointer', borderRadius: '8px', transition: 'background 0.2s' }} onMouseOver={e => e.currentTarget.style.background = 'var(--subtle-bg)'} onMouseOut={e => e.currentTarget.style.background = 'transparent'} onClick={() => setIsOpen(false)}>
                      <div style={{ background: 'rgba(16, 185, 129, 0.1)', padding: '0.5rem', borderRadius: '8px', border: '1px solid rgba(16, 185, 129, 0.2)' }}><Briefcase size={18} color="#10b981" /></div>
                      <div><div style={{ fontWeight: '500', color: 'var(--text-primary)' }}>{d.title}</div><div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Stage Map: <span style={{color: '#10b981'}}>{d.stage}</span> • Target: ${d.amount.toLocaleString()}</div></div>
                    </div>
                  ))}
                </div>
              )}

              {/* Invoices */}
              {results.invoices.length > 0 && (
                <div style={{ marginBottom: '0.5rem' }}>
                  <h4 style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', padding: '0.5rem 1rem' }}>Financial Ledgers</h4>
                  {results.invoices.map(i => (
                    <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.75rem 1rem', cursor: 'pointer', borderRadius: '8px', transition: 'background 0.2s' }} onMouseOver={e => e.currentTarget.style.background = 'var(--subtle-bg)'} onMouseOut={e => e.currentTarget.style.background = 'transparent'} onClick={() => setIsOpen(false)}>
                      <div style={{ background: 'rgba(245, 158, 11, 0.1)', padding: '0.5rem', borderRadius: '8px', border: '1px solid rgba(245, 158, 11, 0.2)' }}><FileText size={18} color="#f59e0b" /></div>
                      <div>
                        <div style={{ fontWeight: '500', color: 'var(--text-primary)' }}>{i.invoiceNum} <span style={{ fontSize: '0.65rem', padding: '0.1rem 0.4rem', borderRadius: '4px', background: i.status === 'PAID' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)', color: i.status === 'PAID' ? '#10b981' : '#ef4444', marginLeft: '0.5rem', verticalAlign: 'middle' }}>{i.status}</span></div>
                        <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Entity: {i.contact?.name || 'Unknown'} • Value: ${i.amount.toLocaleString()}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          
          <div style={{ padding: '0.75rem 1.5rem', borderTop: '1px solid var(--border-color)', backgroundColor: 'var(--surface-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>Use <kbd style={{ padding: '0.2rem 0.4rem', border: '1px solid var(--border-color)', borderRadius: '4px', background: 'var(--subtle-bg)', color: 'var(--text-primary)', fontFamily: 'monospace' }}>↑</kbd> <kbd style={{ padding: '0.2rem 0.4rem', border: '1px solid var(--border-color)', borderRadius: '4px', background: 'var(--subtle-bg)', color: 'var(--text-primary)', fontFamily: 'monospace' }}>↓</kbd> to navigate</span>
            <span style={{color: 'var(--accent-color)', opacity: 0.5}}>Federated Multi-Index Search Matrix</span>
          </div>

        </div>
      </div>
    </div>
  );
}
