import React, { useState, useEffect, useRef } from 'react';
import { Search, FileText, User, ArrowRight, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNavigate } from 'react-router-dom';

const CommandPalette = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [deals, setDeals] = useState([]);
  const [contacts, setContacts] = useState([]);
  const inputRef = useRef(null);
  const navigate = useNavigate();

  // Listen for Cmd+K or Ctrl+K
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
      // Fetch data for searching
      fetchApi('/api/deals').then(setDeals).catch(() => {});
      fetchApi('/api/contacts').then(setContacts).catch(() => {});
    } else {
      setQuery('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const filteredDeals = deals.filter(d => d.title?.toLowerCase().includes(query.toLowerCase()) || d.company?.toLowerCase().includes(query.toLowerCase()));
  const filteredContacts = contacts.filter(c => c.name?.toLowerCase().includes(query.toLowerCase()) || c.email?.toLowerCase().includes(query.toLowerCase()));

  const handleSelect = (path) => {
    navigate(path);
    setIsOpen(false);
  };

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(12px)', zIndex: 9999, display: 'flex', justifyContent: 'center', paddingTop: '10vh', animation: 'fadeIn 0.2s ease-out' }} onClick={() => setIsOpen(false)}>
      <div 
        className="card" 
        style={{ width: '600px', maxHeight: '60vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.8)' }} 
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: '1.25rem', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '1rem', background: 'rgba(255,255,255,0.02)' }}>
          <Search size={24} color="var(--text-secondary)" />
          <input 
            ref={inputRef}
            type="text" 
            placeholder="Search deals, contacts, or jump to..." 
            value={query} 
            onChange={e => setQuery(e.target.value)}
            style={{ flex: 1, background: 'transparent', border: 'none', color: 'var(--text-primary)', fontSize: '1.25rem', outline: 'none' }}
          />
          <button style={{ background: 'rgba(255,255,255,0.1)', border: 'none', padding: '0.25rem 0.5rem', borderRadius: '4px', color: 'var(--text-secondary)', fontSize: '0.75rem', fontWeight: 'bold' }}>ESC</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '1rem' }}>
          
          {query.length === 0 ? (
            <div style={{ padding: '1rem' }}>
              <p style={{ fontSize: '0.75rem', fontWeight: 'bold', color: 'var(--text-secondary)', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Quick Links</p>
              <div 
                style={{ padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', gap: '1rem', borderRadius: '8px', cursor: 'pointer', transition: 'var(--transition)' }} 
                className="table-row-hover"
                onClick={() => handleSelect('/pipeline')}
              >
                <FileText size={18} color="var(--accent-color)" />
                <span style={{ flex: 1, fontWeight: '500' }}>Sales Pipeline</span>
                <ArrowRight size={16} color="var(--text-secondary)" />
              </div>
              <div 
                style={{ padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', gap: '1rem', borderRadius: '8px', cursor: 'pointer', transition: 'var(--transition)' }} 
                className="table-row-hover"
                onClick={() => handleSelect('/contacts')}
              >
                <User size={18} color="var(--success-color)" />
                <span style={{ flex: 1, fontWeight: '500' }}>Contact Directory</span>
                <ArrowRight size={16} color="var(--text-secondary)" />
              </div>
            </div>
          ) : (
            <>
              {filteredDeals.length > 0 && (
                <div style={{ marginBottom: '1.5rem' }}>
                  <p style={{ fontSize: '0.75rem', fontWeight: 'bold', color: 'var(--text-secondary)', marginBottom: '0.5rem', padding: '0 1rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Deals</p>
                  {filteredDeals.map(deal => (
                     <div 
                      key={deal.id} 
                      style={{ padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', gap: '1rem', borderRadius: '8px', cursor: 'pointer', transition: 'var(--transition)' }} 
                      className="table-row-hover"
                      onClick={() => handleSelect('/pipeline')}
                    >
                      <FileText size={18} color="var(--text-secondary)" />
                      <div style={{ flex: 1 }}>
                        <p style={{ fontWeight: '500' }}>{deal.title}</p>
                        <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{deal.company} • ${(deal.amount || 0).toLocaleString()}</p>
                      </div>
                      <span style={{ fontSize: '0.75rem', padding: '0.1rem 0.5rem', borderRadius: '8px', background: 'rgba(255,255,255,0.1)' }}>{deal.stage}</span>
                    </div>
                  ))}
                </div>
              )}

              {filteredContacts.length > 0 && (
                <div style={{ marginBottom: '1.5rem' }}>
                  <p style={{ fontSize: '0.75rem', fontWeight: 'bold', color: 'var(--text-secondary)', marginBottom: '0.5rem', padding: '0 1rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Contacts</p>
                  {filteredContacts.map(contact => (
                     <div 
                      key={contact.id} 
                      style={{ padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', gap: '1rem', borderRadius: '8px', cursor: 'pointer', transition: 'var(--transition)' }} 
                      className="table-row-hover"
                      onClick={() => handleSelect('/contacts')}
                    >
                      <User size={18} color="var(--text-secondary)" />
                      <div style={{ flex: 1 }}>
                        <p style={{ fontWeight: '500' }}>{contact.name}</p>
                        <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{contact.email} • {contact.role}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {filteredDeals.length === 0 && filteredContacts.length === 0 && (
                <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
                  <Search size={32} style={{ marginBottom: '1rem', opacity: 0.5 }} />
                  <p>No results found for "{query}"</p>
                </div>
              )}
            </>
          )}

        </div>
        <div style={{ padding: '0.75rem 1rem', background: 'var(--surface-color)', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'center', gap: '2rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          <span style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}><span style={{ padding: '0.2rem 0.4rem', background: 'rgba(255,255,255,0.1)', borderRadius: '4px', fontWeight: 'bold' }}>↑↓</span> to navigate</span>
          <span style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}><span style={{ padding: '0.2rem 0.4rem', background: 'rgba(255,255,255,0.1)', borderRadius: '4px', fontWeight: 'bold' }}>Enter</span> to select</span>
        </div>
      </div>
    </div>
  );
};

export default CommandPalette;
