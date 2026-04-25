import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, User, Mail, Building, Briefcase, Phone, Clock, FileText } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

export default function ContactsDetail() {
  const notify = useNotify();
  const { id } = useParams();
  const navigate = useNavigate();
  const [contact, setContact] = useState(null);
  const [loading, setLoading] = useState(true);
  const [newActivity, setNewActivity] = useState({ type: 'Note', description: '' });

  const loadData = () => {
    fetchApi(`/api/contacts/${id}`)
      .then(data => { setContact(data); setLoading(false); })
      .catch(err => { console.error(err); setLoading(false); });
  };

  useEffect(() => { loadData(); }, [id]);

  const postActivity = async (e) => {
    e.preventDefault();
    try {
      await fetchApi(`/api/contacts/${id}/activities`, { method: 'POST', body: JSON.stringify(newActivity) });
      setNewActivity({ type: 'Note', description: '' });
      loadData();
    } catch (err) { notify.error('Failed to log activity'); }
  };

  if (loading) {
    return <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading contact record...</div>;
  }

  if (!contact) {
    return (
      <div style={{ padding: '3rem', textAlign: 'center' }}>
        <h2 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>Contact Not Found</h2>
        <button className="btn-secondary" onClick={() => navigate('/contacts')}>Return to Contacts</button>
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease-out', maxWidth: '1000px', margin: '0 auto' }}>
      <button 
        onClick={() => navigate('/contacts')} 
        style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginBottom: '2rem', fontWeight: '500', transition: 'color 0.2s' }}
        onMouseOver={e => e.currentTarget.style.color = 'var(--text-primary)'}
        onMouseOut={e => e.currentTarget.style.color = 'var(--text-secondary)'}
      >
        <ArrowLeft size={18} /> Back to Directory
      </button>

      <div className="card" style={{ padding: '3rem', display: 'flex', gap: '3rem', alignItems: 'flex-start' }}>
        <div style={{ width: '120px', height: '120px', borderRadius: '50%', background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(168, 85, 247, 0.2))', border: '2px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-color)', flexShrink: 0 }}>
          <User size={64} />
        </div>
        
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' }}>
            <div>
              <h1 style={{ fontSize: '2.5rem', fontWeight: 'bold', marginBottom: '0.5rem', letterSpacing: '-0.02em' }}>{contact.name}</h1>
              <p style={{ fontSize: '1.1rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Briefcase size={16} /> {contact.title || 'Unknown Title'} at {contact.company || 'Unknown Company'}
              </p>
            </div>
            <span style={{ 
              padding: '0.5rem 1rem', 
              borderRadius: '999px', 
              fontSize: '0.875rem',
              fontWeight: 'bold',
              backgroundColor: contact.status === 'Lead' ? 'rgba(59, 130, 246, 0.1)' : 'rgba(16, 185, 129, 0.1)',
              color: contact.status === 'Lead' ? 'var(--accent-color)' : 'var(--success-color)'
            }}>
              {contact.status}
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', padding: '1.5rem', background: 'var(--subtle-bg-2)', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <div style={{ padding: '0.5rem', background: 'var(--subtle-bg)', borderRadius: '8px', color: 'var(--text-secondary)' }}><Mail size={18}/></div>
              <div>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Email Address</p>
                <p style={{ fontWeight: '500' }}>{contact.email}</p>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <div style={{ padding: '0.5rem', background: 'var(--subtle-bg)', borderRadius: '8px', color: 'var(--text-secondary)' }}><Phone size={18}/></div>
              <div>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Phone Number</p>
                <p style={{ fontWeight: '500' }}>{contact.phone || 'Not Provided'}</p>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <div style={{ padding: '0.5rem', background: 'var(--subtle-bg)', borderRadius: '8px', color: 'var(--text-secondary)' }}><Building size={18}/></div>
              <div>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Organization</p>
                <p style={{ fontWeight: '500' }}>{contact.company || 'Not Provided'}</p>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <div style={{ padding: '0.5rem', background: 'var(--subtle-bg)', borderRadius: '8px', color: 'var(--text-secondary)' }}><Clock size={18}/></div>
              <div>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Record Created</p>
                <p style={{ fontWeight: '500' }}>{contact.createdAt ? new Date(contact.createdAt).toLocaleDateString() : 'Unknown'}</p>
              </div>
            </div>
          </div>
          
          <div style={{ marginTop: '2rem' }}>
            <h3 style={{ fontSize: '1.25rem', fontWeight: 'bold', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <FileText size={20} color="var(--accent-color)" /> CRM Interaction History
            </h3>
            
            <form onSubmit={postActivity} className="card" style={{ padding: '1.5rem', marginBottom: '2rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ display: 'flex', gap: '1rem' }}>
                <select className="input-field" value={newActivity.type} onChange={e => setNewActivity({...newActivity, type: e.target.value})} style={{ width: '150px' }}>
                  <option>Note</option>
                  <option>Call</option>
                  <option>Email</option>
                  <option>Meeting</option>
                </select>
                <input type="text" className="input-field" placeholder="Describe the interaction..." required value={newActivity.description} onChange={e => setNewActivity({...newActivity, description: e.target.value})} style={{ flex: 1 }} />
                <button type="submit" className="btn-primary" style={{ padding: '0 1.5rem' }}>Log</button>
              </div>
            </form>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {(!contact.activities || contact.activities.length === 0) ? (
                <div style={{ padding: '2rem', border: '1px dashed var(--border-color)', borderRadius: '12px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                  No recent interactions logged for this contact.
                </div>
              ) : contact.activities.map(act => (
                <div key={act.id} style={{ display: 'flex', gap: '1.5rem', padding: '1.5rem', background: 'var(--subtle-bg-2)', borderRadius: '8px', borderLeft: '4px solid var(--accent-color)' }}>
                  <div style={{ padding: '0.5rem', background: 'var(--subtle-bg)', borderRadius: '50%', height: '40px', width: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {act.type === 'Email' ? <Mail size={18} color="var(--success-color)"/> : act.type === 'Call' ? <Phone size={18} color="var(--warning-color)"/> : <FileText size={18} color="var(--accent-color)" />}
                  </div>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.25rem' }}>
                      <span style={{ fontWeight: 'bold' }}>{act.type}</span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{new Date(act.createdAt).toLocaleString()}</span>
                    </div>
                    <p style={{ color: 'var(--text-primary)' }}>{act.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
