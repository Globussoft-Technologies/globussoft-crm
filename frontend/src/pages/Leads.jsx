import { fetchApi } from '../utils/api';
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserPlus, Search, ArrowRightCircle, UserCheck, Users } from 'lucide-react';

const SOURCE_OPTIONS = ['Organic', 'Referral', 'LinkedIn', 'Cold Call', 'Website', 'Event', 'Other'];

const Leads = () => {
  const navigate = useNavigate();
  const [leads, setLeads] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedLeads, setSelectedLeads] = useState([]);
  const [bulkAgent, setBulkAgent] = useState('');
  const [newLead, setNewLead] = useState({
    name: '',
    email: '',
    company: '',
    title: '',
    source: 'Organic',
    status: 'Lead',
  });

  const fetchLeads = () => {
    setLoading(true);
    fetchApi('/api/contacts?status=Lead')
      .then(data => {
        setLeads(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  const fetchStaff = () => {
    fetchApi('/api/staff')
      .then(data => setStaff(data))
      .catch(() => {});
  };

  useEffect(() => {
    fetchLeads();
    fetchStaff();
  }, []);

  const handleCreateLead = async (e) => {
    e.preventDefault();
    await fetchApi('/api/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newLead),
    });
    setNewLead({ name: '', email: '', company: '', title: '', source: 'Organic', status: 'Lead' });
    fetchLeads();
  };

  const handleConvert = async (id) => {
    // Bug #283: pipeline is Lead -> Prospect -> Customer -> Churned. The
    // Convert button must move the lead one step (to Prospect), not jump
    // straight to Customer. ConvertedLeads.jsx defaults to the "Prospect"
    // tab, so this is also where the user expects to find the row next.
    await fetchApi(`/api/contacts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Prospect' }),
    });
    fetchLeads();
  };

  const handleAssign = async (contactId, assignedToId) => {
    await fetchApi(`/api/contacts/${contactId}/assign`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignedToId: assignedToId || null }),
    });
    fetchLeads();
  };

  const handleBulkAssign = async () => {
    if (selectedLeads.length === 0) return;
    await fetchApi('/api/contacts/bulk-assign', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactIds: selectedLeads, assignedToId: bulkAgent || null }),
    });
    setSelectedLeads([]);
    setBulkAgent('');
    fetchLeads();
  };

  const toggleSelect = (id) => {
    setSelectedLeads(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const toggleSelectAll = () => {
    if (selectedLeads.length === filteredLeads.length) {
      setSelectedLeads([]);
    } else {
      setSelectedLeads(filteredLeads.map(l => l.id));
    }
  };

  const handleChange = (field, value) => {
    setNewLead(prev => ({ ...prev, [field]: value }));
  };

  const filteredLeads = leads.filter(lead => {
    const term = searchTerm.toLowerCase();
    return (
      lead.name.toLowerCase().includes(term) ||
      (lead.email && lead.email.toLowerCase().includes(term)) ||
      (lead.company && lead.company.toLowerCase().includes(term))
    );
  });

  const formatDate = (dateStr) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <UserPlus size={24} style={{ color: 'var(--accent-color)' }} />
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Leads</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              {leads.length} lead{leads.length !== 1 ? 's' : ''} in pipeline
            </p>
          </div>
        </div>
      </header>

      {/* Bulk Assign Bar */}
      {selectedLeads.length > 0 && (
        <div className="card" style={{ padding: '0.75rem 1.25rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '1rem', background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.2)' }}>
          <Users size={18} color="var(--accent-color)" />
          <span style={{ fontWeight: '500', fontSize: '0.875rem' }}>{selectedLeads.length} lead{selectedLeads.length !== 1 ? 's' : ''} selected</span>
          <select
            className="input-field"
            value={bulkAgent}
            onChange={e => setBulkAgent(e.target.value)}
            style={{ width: '200px', padding: '0.5rem' }}
          >
            <option value="">Unassign</option>
            {staff.map(s => (
              <option key={s.id} value={s.id}>{s.name || s.email}</option>
            ))}
          </select>
          <button className="btn-primary" onClick={handleBulkAssign} style={{ padding: '0.5rem 1rem', fontSize: '0.875rem' }}>
            <UserCheck size={15} style={{ marginRight: '0.375rem', verticalAlign: 'middle' }} />
            Assign
          </button>
          <button onClick={() => setSelectedLeads([])} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.875rem' }}>
            Clear
          </button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: '1.5rem', alignItems: 'start' }}>
        {/* Left Panel: Create Lead Form */}
        <div className="card" style={{ padding: '1.5rem' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: '600', marginBottom: '1.25rem' }}>Create Lead</h3>
          <form onSubmit={handleCreateLead} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
            <input type="text" placeholder="Full Name" required className="input-field" value={newLead.name} onChange={e => handleChange('name', e.target.value)} />
            <input type="email" placeholder="Email Address" required className="input-field" value={newLead.email} onChange={e => handleChange('email', e.target.value)} />
            <input type="text" placeholder="Company" className="input-field" value={newLead.company} onChange={e => handleChange('company', e.target.value)} />
            <input type="text" placeholder="Job Title" className="input-field" value={newLead.title} onChange={e => handleChange('title', e.target.value)} />
            <select className="input-field" value={newLead.source} onChange={e => handleChange('source', e.target.value)}>
              {SOURCE_OPTIONS.map(src => (
                <option key={src} value={src}>{src}</option>
              ))}
            </select>
            <button type="submit" className="btn-primary" style={{ marginTop: '0.5rem' }}>
              Add Lead
            </button>
          </form>
        </div>

        {/* Right Panel: Leads Table */}
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '1rem', borderBottom: '1px solid var(--border-color)' }}>
            <div style={{ position: 'relative', maxWidth: '300px' }}>
              <Search size={18} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
              <input
                type="text"
                className="input-field"
                placeholder="Search leads..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                style={{ paddingLeft: '2.5rem', backgroundColor: 'var(--surface-hover)' }}
              />
            </div>
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--table-header-bg)' }}>
                <th style={{ padding: '1rem', width: '40px' }}>
                  <input type="checkbox" checked={selectedLeads.length === filteredLeads.length && filteredLeads.length > 0} onChange={toggleSelectAll} style={{ cursor: 'pointer' }} />
                </th>
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Name</th>
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Email</th>
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Company</th>
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>AI Score</th>
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Source</th>
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Assigned To</th>
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Created</th>
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan="9" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading leads...</td></tr>
              ) : filteredLeads.length === 0 ? (
                <tr><td colSpan="9" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No leads found</td></tr>
              ) : filteredLeads.map(lead => (
                <tr
                  key={lead.id}
                  style={{ borderBottom: '1px solid var(--border-color)', cursor: 'pointer' }}
                  className="table-row-hover"
                  onClick={() => navigate(`/contacts/${lead.id}`)}
                  title="Open lead detail"
                >
                  <td style={{ padding: '1rem' }} onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={selectedLeads.includes(lead.id)} onChange={() => toggleSelect(lead.id)} style={{ cursor: 'pointer' }} />
                  </td>
                  <td style={{ padding: '1rem', fontWeight: '500' }}>{lead.name}</td>
                  <td style={{ padding: '1rem', color: 'var(--text-secondary)' }}>{lead.email}</td>
                  <td style={{ padding: '1rem', color: 'var(--text-secondary)' }}>{lead.company}</td>
                  <td style={{ padding: '1rem' }}>
                    <span style={{
                      padding: '0.25rem 0.75rem',
                      borderRadius: '999px',
                      fontSize: '0.75rem',
                      fontWeight: 'bold',
                      backgroundColor: lead.aiScore > 75 ? 'rgba(16, 185, 129, 0.1)' : lead.aiScore > 40 ? 'rgba(245, 158, 11, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                      color: lead.aiScore > 75 ? 'var(--success-color)' : lead.aiScore > 40 ? 'var(--warning-color)' : '#ef4444',
                    }}>
                      {lead.aiScore}/100
                    </span>
                  </td>
                  <td style={{ padding: '1rem' }}>
                    <span style={{
                      padding: '0.25rem 0.75rem',
                      borderRadius: '999px',
                      fontSize: '0.75rem',
                      backgroundColor: 'rgba(139, 92, 246, 0.1)',
                      color: '#8b5cf6',
                    }}>
                      {lead.source || 'Organic'}
                    </span>
                  </td>
                  <td style={{ padding: '1rem' }} onClick={e => e.stopPropagation()}>
                    <select
                      className="input-field"
                      value={lead.assignedToId || ''}
                      onChange={e => handleAssign(lead.id, e.target.value)}
                      style={{ padding: '0.375rem 0.5rem', fontSize: '0.8rem', minWidth: '130px', background: 'var(--input-bg)' }}
                    >
                      <option value="">Unassigned</option>
                      {staff.map(s => (
                        <option key={s.id} value={s.id}>{s.name || s.email}</option>
                      ))}
                    </select>
                  </td>
                  <td style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                    {formatDate(lead.createdAt)}
                  </td>
                  <td style={{ padding: '1rem', textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => handleConvert(lead.id)}
                      title="Convert to Customer"
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--success-color)',
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.375rem',
                        fontSize: '0.8rem',
                        fontWeight: '500',
                      }}
                    >
                      <ArrowRightCircle size={16} />
                      Convert
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default Leads;
