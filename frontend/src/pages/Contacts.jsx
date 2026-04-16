import { fetchApi } from '../utils/api';
import React, { useState, useEffect } from 'react';
import { Search, Plus, MoreVertical, Trash2, RefreshCw, TrendingUp, Upload, X, FileSpreadsheet, UserCheck, GitMerge } from 'lucide-react';
import { Link } from 'react-router-dom';

const parseCSV = (text) => {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g, ''));
  return lines.slice(1).map(line => {
    // Handle quoted values with commas
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQuotes = !inQuotes; continue; }
      if (line[i] === ',' && !inQuotes) { values.push(current.trim()); current = ''; continue; }
      current += line[i];
    }
    values.push(current.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] || ''; });
    return row;
  });
};

const Contacts = () => {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [newContact, setNewContact] = useState({ name: '', email: '', phone: '', company: '', title: '', status: 'Lead' });
  const [showImportModal, setShowImportModal] = useState(false);
  const [csvRows, setCsvRows] = useState([]);
  const [csvHeaders, setCsvHeaders] = useState([]);
  const [importResult, setImportResult] = useState(null);
  const [importing, setImporting] = useState(false);

  const [staff, setStaff] = useState([]);
  const [rescoring, setRescoring] = useState(false);
  const [showDupes, setShowDupes] = useState(false);
  const [dupes, setDupes] = useState([]);
  const [merging, setMerging] = useState(false);

  const handleFindDupes = async () => {
    try {
      const data = await fetchApi('/api/contacts/duplicates/find');
      setDupes(Array.isArray(data) ? data : []);
      setShowDupes(true);
    } catch { setDupes([]); }
  };

  const handleMerge = async (primaryId, secondaryIds) => {
    setMerging(true);
    try {
      await fetchApi('/api/contacts/merge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ primaryId, secondaryIds })
      });
      handleFindDupes();
      fetchContacts();
    } catch { alert('Merge failed'); }
    setMerging(false);
  };

  const fetchContacts = () => {
    fetchApi('/api/contacts').then(data => {
        setContacts(Array.isArray(data) ? data : []);
        setLoading(false);
      }).catch(() => { setContacts([]); setLoading(false); });
  };

  const handleRescore = async () => {
    setRescoring(true);
    try {
      await fetchApi('/api/ai_scoring/trigger', { method: 'POST' });
      fetchContacts();
    } catch (e) {
      console.error(e);
    } finally {
      setRescoring(false);
    }
  };

  useEffect(() => {
    fetchContacts();
    fetchApi('/api/staff').then(data => setStaff(data)).catch(() => {});
  }, []);

  const handleAssign = async (contactId, assignedToId) => {
    await fetchApi(`/api/contacts/${contactId}/assign`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignedToId: assignedToId || null }),
    });
    fetchContacts();
  };

  const handleAddContact = async (e) => {
    e.preventDefault();
    await fetchApi('/api/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newContact)
    });
    setShowModal(false);
    setNewContact({ name: '', email: '', phone: '', company: '', title: '', status: 'Lead' });
    fetchContacts();
  };

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const rows = parseCSV(ev.target.result);
      if (rows.length > 0) {
        setCsvHeaders(Object.keys(rows[0]));
        setCsvRows(rows);
        setImportResult(null);
      }
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (csvRows.length === 0) return;
    setImporting(true);
    try {
      const mapped = csvRows.map(row => ({
        name: row.name || row.Name || '',
        email: row.email || row.Email || '',
        company: row.company || row.Company || '',
        title: row.title || row.Title || '',
        status: row.status || row.Status || 'Lead',
      }));
      const result = await fetchApi('/api/contacts/import-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contacts: mapped })
      });
      setImportResult(result);
      fetchContacts();
    } catch (err) {
      setImportResult({ error: 'Import failed' });
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async (id) => {
    if (window.confirm("Are you sure you want to delete this contact?")) {
      await fetchApi(`/api/contacts/${id}`, { method: 'DELETE' });
      fetchContacts();
    }
  };

  return (
    <div style={{ padding: '2rem' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Contacts</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Manage your leads and customers</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button
            onClick={handleRescore}
            disabled={rescoring}
            className="btn-secondary"
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', opacity: rescoring ? 0.7 : 1 }}
            title="Re-run AI scoring engine"
          >
            <RefreshCw size={15} style={{ animation: rescoring ? 'spin 1s linear infinite' : 'none' }} />
            {rescoring ? 'Scoring...' : 'AI Re-score'}
          </button>
          <button onClick={handleFindDupes} className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <GitMerge size={15} /> Find Duplicates
          </button>
          <button onClick={() => { setShowImportModal(true); setCsvRows([]); setCsvHeaders([]); setImportResult(null); }} className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Upload size={15} /> Import CSV
          </button>
          <button onClick={() => setShowModal(true)} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={18} /> Add Contact
          </button>
        </div>
      </header>
      
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '1rem', borderBottom: '1px solid var(--border-color)', display: 'flex', gap: '1rem' }}>
          <div style={{ position: 'relative', flex: 1, maxWidth: '300px' }}>
            <Search size={18} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
            <input 
              type="text" 
              className="input-field" 
              placeholder="Search contacts..." 
              style={{ paddingLeft: '2.5rem', backgroundColor: 'var(--surface-hover)' }}
            />
          </div>
          <select className="input-field" style={{ width: '150px' }}>
            <option value="All">All Statuses</option>
            <option value="Lead">Lead</option>
            <option value="Customer">Customer</option>
          </select>
        </div>
        
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--table-header-bg)' }}>
              <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Name</th>
              <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Email</th>
              <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Phone</th>
              <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Company</th>
              <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>AI Score</th>
              <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Status</th>
              <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Assigned To</th>
              <th style={{ padding: '1rem', textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="8" style={{ padding: '2rem', textAlign: 'center' }}>Loading contacts...</td></tr>
            ) : contacts.map(contact => (
              <tr key={contact.id} style={{ borderBottom: '1px solid var(--border-color)' }} className="table-row-hover">
                <td style={{ padding: '1rem' }}>
                  <div style={{ fontWeight: '500' }}>
                    <Link to={`/contacts/${contact.id}`} style={{ color: 'var(--text-primary)', textDecoration: 'none', display: 'block', pointerEvents: 'all', position: 'relative', zIndex: 10 }} className="hover-underline">
                      {contact.name}
                    </Link>
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{contact.title}</div>
                </td>
                <td style={{ padding: '1rem', color: 'var(--text-secondary)' }}>{contact.email}</td>
                <td style={{ padding: '1rem', color: 'var(--text-secondary)' }}>{contact.phone || '—'}</td>
                <td style={{ padding: '1rem', color: 'var(--text-secondary)' }}>{contact.company}</td>
                <td style={{ padding: '1rem' }}>
                  <span style={{ 
                    padding: '0.25rem 0.75rem', 
                    borderRadius: '999px', 
                    fontSize: '0.75rem',
                    fontWeight: 'bold',
                    backgroundColor: contact.aiScore > 75 ? 'rgba(16, 185, 129, 0.1)' : contact.aiScore > 40 ? 'rgba(245, 158, 11, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                    color: contact.aiScore > 75 ? 'var(--success-color)' : contact.aiScore > 40 ? 'var(--warning-color)' : '#ef4444'
                  }}>
                    {contact.aiScore}/100
                  </span>
                </td>
                <td style={{ padding: '1rem' }}>
                  <span style={{ 
                    padding: '0.25rem 0.75rem', 
                    borderRadius: '999px', 
                    fontSize: '0.75rem',
                    backgroundColor: contact.status === 'Lead' ? 'rgba(59, 130, 246, 0.1)' : 'rgba(16, 185, 129, 0.1)',
                    color: contact.status === 'Lead' ? 'var(--accent-color)' : 'var(--success-color)'
                  }}>
                    {contact.status}
                  </span>
                </td>
                <td style={{ padding: '1rem' }}>
                  <select
                    className="input-field"
                    value={contact.assignedToId || ''}
                    onChange={e => handleAssign(contact.id, e.target.value)}
                    style={{ padding: '0.375rem 0.5rem', fontSize: '0.8rem', minWidth: '130px', background: 'var(--input-bg)' }}
                  >
                    <option value="">Unassigned</option>
                    {staff.map(s => (
                      <option key={s.id} value={s.id}>{s.name || s.email}</option>
                    ))}
                  </select>
                </td>
                <td style={{ padding: '1rem', textAlign: 'right' }}>
                  <button onClick={() => handleDelete(contact.id)} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}>
                    <Trash2 size={18} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showImportModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ padding: '2rem', width: '600px', maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ fontSize: '1.25rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <FileSpreadsheet size={20} color="var(--accent-color)" /> Import CSV
              </h3>
              <button onClick={() => setShowImportModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}><X size={20} /></button>
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <label style={{ display: 'block', padding: '2rem', border: '2px dashed var(--border-color)', borderRadius: '12px', textAlign: 'center', cursor: 'pointer', transition: 'var(--transition)' }}>
                <Upload size={32} style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }} />
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Click to select a .csv file</p>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginTop: '0.25rem' }}>Expected columns: name, email, company, title, status</p>
                <input type="file" accept=".csv" onChange={handleFileSelect} style={{ display: 'none' }} />
              </label>
            </div>

            {csvRows.length > 0 && !importResult && (
              <>
                <div style={{ marginBottom: '1rem' }}>
                  <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                    Detected columns: <strong>{csvHeaders.join(', ')}</strong>
                  </p>
                  <p style={{ fontSize: '0.875rem', color: 'var(--text-primary)' }}>
                    {csvRows.length} row{csvRows.length !== 1 ? 's' : ''} found — previewing first {Math.min(5, csvRows.length)}:
                  </p>
                </div>
                <div style={{ overflowX: 'auto', marginBottom: '1.5rem' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                        {csvHeaders.map(h => (
                          <th key={h} style={{ padding: '0.5rem', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: '500' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {csvRows.slice(0, 5).map((row, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border-color)' }}>
                          {csvHeaders.map(h => (
                            <td key={h} style={{ padding: '0.5rem', color: 'var(--text-primary)' }}>{row[h]}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button onClick={handleImport} disabled={importing} className="btn-primary" style={{ width: '100%', opacity: importing ? 0.7 : 1 }}>
                  {importing ? 'Importing...' : `Import ${csvRows.length} Contact${csvRows.length !== 1 ? 's' : ''}`}
                </button>
              </>
            )}

            {importResult && !importResult.error && (
              <div style={{ padding: '1.5rem', background: 'rgba(16, 185, 129, 0.1)', borderRadius: '12px', border: '1px solid rgba(16, 185, 129, 0.3)' }}>
                <p style={{ fontWeight: '600', color: 'var(--success-color)', marginBottom: '0.5rem', fontSize: '1rem' }}>Import Complete</p>
                <p style={{ fontSize: '0.875rem', color: 'var(--text-primary)' }}>{importResult.imported} imported, {importResult.skipped} skipped (duplicate email)</p>
                {importResult.errors && importResult.errors.length > 0 && (
                  <div style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: '#ef4444' }}>
                    {importResult.errors.map((e, i) => <p key={i}>{e}</p>)}
                  </div>
                )}
                <button onClick={() => setShowImportModal(false)} className="btn-primary" style={{ marginTop: '1rem', width: '100%' }}>Done</button>
              </div>
            )}

            {importResult && importResult.error && (
              <div style={{ padding: '1.5rem', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '12px', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
                <p style={{ fontWeight: '600', color: '#ef4444' }}>Import Failed</p>
                <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>{importResult.error}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {showModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ padding: '2rem', width: '400px' }}>
            <h3 style={{ marginBottom: '1.5rem', fontSize: '1.25rem', fontWeight: 'bold' }}>Add New Contact</h3>
            <form onSubmit={handleAddContact} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <input type="text" placeholder="Name" required className="input-field" value={newContact.name} onChange={e => setNewContact({...newContact, name: e.target.value})} />
              <input type="email" placeholder="Email" required className="input-field" value={newContact.email} onChange={e => setNewContact({...newContact, email: e.target.value})} />
              <input type="tel" placeholder="Phone (e.g. +91 98765 43210)" className="input-field" value={newContact.phone} onChange={e => setNewContact({...newContact, phone: e.target.value})} />
              <input type="text" placeholder="Company" required className="input-field" value={newContact.company} onChange={e => setNewContact({...newContact, company: e.target.value})} />
              <input type="text" placeholder="Title" className="input-field" value={newContact.title} onChange={e => setNewContact({...newContact, title: e.target.value})} />
              <select className="input-field" value={newContact.status} onChange={e => setNewContact({...newContact, status: e.target.value})}>
                <option value="Lead">Lead</option>
                <option value="Customer">Customer</option>
              </select>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '1rem' }}>
                <button type="button" onClick={() => setShowModal(false)} style={{ background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer' }}>Cancel</button>
                <button type="submit" className="btn-primary">Save Contact</button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Duplicate Contacts Modal */}
      {showDupes && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ padding: '2rem', width: '700px', maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ fontSize: '1.25rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <GitMerge size={20} color="var(--accent-color)" /> Duplicate Contacts ({dupes.length} groups)
              </h3>
              <button onClick={() => setShowDupes(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}><X size={20} /></button>
            </div>
            {dupes.length === 0 ? (
              <p style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>No duplicate contacts found. Your database is clean!</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {dupes.map((group, gi) => (
                  <div key={gi} className="card" style={{ padding: '1rem', border: '1px solid rgba(245,158,11,0.3)', background: 'rgba(245,158,11,0.03)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                      <span style={{ fontSize: '0.75rem', color: '#f59e0b', fontWeight: '600' }}>Match: {group.reason}</span>
                      <button
                        onClick={() => handleMerge(group.primary.id, group.duplicates.map(d => d.id))}
                        disabled={merging}
                        className="btn-primary"
                        style={{ padding: '0.3rem 0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
                      >
                        <GitMerge size={12} /> Merge into Primary
                      </button>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 0.75rem', borderRadius: '6px', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)' }}>
                        <span style={{ fontSize: '0.65rem', fontWeight: '700', color: '#10b981', textTransform: 'uppercase' }}>Primary</span>
                        <span style={{ fontWeight: '500', fontSize: '0.85rem' }}>{group.primary.name}</span>
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{group.primary.email}</span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{group.primary.company}</span>
                        <span style={{ fontSize: '0.7rem', marginLeft: 'auto', color: 'var(--text-secondary)' }}>Score: {group.primary.aiScore}</span>
                      </div>
                      {group.duplicates.map(dup => (
                        <div key={dup.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 0.75rem', borderRadius: '6px', background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.15)' }}>
                          <span style={{ fontSize: '0.65rem', fontWeight: '700', color: '#ef4444', textTransform: 'uppercase' }}>Dup</span>
                          <span style={{ fontWeight: '500', fontSize: '0.85rem' }}>{dup.name}</span>
                          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{dup.email}</span>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{dup.company}</span>
                          <span style={{ fontSize: '0.7rem', marginLeft: 'auto', color: 'var(--text-secondary)' }}>Score: {dup.aiScore}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default Contacts;
