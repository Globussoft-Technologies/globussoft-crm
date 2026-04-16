import { fetchApi } from '../utils/api';
import React, { useState, useEffect } from 'react';
import { Search, Plus, MessageCircle } from 'lucide-react';

const Support = () => {
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchApi('/api/support').then(data => {
        setTickets(Array.isArray(data) ? data : []);
        setLoading(false);
      }).catch(() => { setTickets([]); setLoading(false); });
  }, []);

  return (
    <div style={{ padding: '2rem' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Customer Support</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Manage helpdesk tickets and customer issues</p>
        </div>
        <button className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Plus size={18} /> New Ticket
        </button>
      </header>

      <div className="card" style={{ overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--table-header-bg)' }}>
              <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Subject</th>
              <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Requester</th>
              <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Status</th>
              <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Priority</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="4" style={{ padding: '2rem', textAlign: 'center' }}>Loading tickets...</td></tr>
            ) : tickets.map(ticket => (
              <tr key={ticket.id} className="table-row-hover" style={{ borderBottom: '1px solid var(--border-color)', cursor: 'pointer' }}>
                <td style={{ padding: '1rem' }}>
                  <div style={{ fontWeight: '500', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <MessageCircle size={16} color="var(--accent-color)" /> {ticket.subject}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>{ticket.lastUpdated}</div>
                </td>
                <td style={{ padding: '1rem', color: 'var(--text-secondary)' }}>{ticket.requester}</td>
                <td style={{ padding: '1rem' }}>
                  <span style={{ 
                    padding: '0.25rem 0.75rem', 
                    borderRadius: '999px', fontSize: '0.75rem',
                    backgroundColor: ticket.status === 'Open' ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)',
                    color: ticket.status === 'Open' ? 'var(--danger-color)' : 'var(--success-color)'
                  }}>
                    {ticket.status}
                  </span>
                </td>
                <td style={{ padding: '1rem', color: 'var(--text-secondary)' }}>{ticket.priority}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default Support;
