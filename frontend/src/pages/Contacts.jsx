import { fetchApi } from '../utils/api';
import React, { useState, useEffect } from 'react';
import { Search, Plus, MoreVertical, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';

const Contacts = () => {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [newContact, setNewContact] = useState({ name: '', email: '', company: '', title: '', status: 'Lead' });

  const fetchContacts = () => {
    fetchApi('/api/contacts').then(data => {
        setContacts(data);
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchContacts();
  }, []);

  const handleAddContact = async (e) => {
    e.preventDefault();
    await fetchApi('/api/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newContact)
    });
    setShowModal(false);
    setNewContact({ name: '', email: '', company: '', title: '', status: 'Lead' });
    fetchContacts();
  };

  const handleDelete = async (id) => {
    if (window.confirm("Are you sure you want to delete this contact?")) {
      await fetchApi('/api/contacts/${id}', { method: 'DELETE' });
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
        <button onClick={() => setShowModal(true)} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Plus size={18} /> Add Contact
        </button>
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
        </div>
        
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: 'rgba(0,0,0,0.2)' }}>
              <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Name</th>
              <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Email</th>
              <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Company</th>
              <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Status</th>
              <th style={{ padding: '1rem', textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="5" style={{ padding: '2rem', textAlign: 'center' }}>Loading contacts...</td></tr>
            ) : contacts.map(contact => (
              <tr key={contact.id} style={{ borderBottom: '1px solid var(--border-color)' }} className="table-row-hover">
                <td style={{ padding: '1rem' }}>
                  <div style={{ fontWeight: '500' }}>
                    <Link to={`/contacts/${contact.id}`} style={{ color: 'var(--text-primary)', textDecoration: 'none' }} className="hover-underline">
                      {contact.name}
                    </Link>
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{contact.title}</div>
                </td>
                <td style={{ padding: '1rem', color: 'var(--text-secondary)' }}>{contact.email}</td>
                <td style={{ padding: '1rem', color: 'var(--text-secondary)' }}>{contact.company}</td>
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

      {showModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ padding: '2rem', width: '400px' }}>
            <h3 style={{ marginBottom: '1.5rem', fontSize: '1.25rem', fontWeight: 'bold' }}>Add New Contact</h3>
            <form onSubmit={handleAddContact} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <input type="text" placeholder="Name" required className="input-field" value={newContact.name} onChange={e => setNewContact({...newContact, name: e.target.value})} />
              <input type="email" placeholder="Email" required className="input-field" value={newContact.email} onChange={e => setNewContact({...newContact, email: e.target.value})} />
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
    </div>
  );
};

export default Contacts;
