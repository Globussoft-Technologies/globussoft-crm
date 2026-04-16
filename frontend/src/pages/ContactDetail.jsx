import { fetchApi } from '../utils/api';
import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Phone, Mail, Calendar, Paperclip, Upload, Trash2, FileText, Download, Target } from 'lucide-react';

const ContactDetail = () => {
  const { id } = useParams();
  const [contact, setContact] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadForm, setUploadForm] = useState({ filename: '', fileUrl: '' });

  const loadContact = () => {
    fetchApi(`/api/contacts/${id}`).then(data => setContact(data)).catch(() => {});
  };

  const loadAttachments = () => {
    fetchApi(`/api/contacts/${id}/attachments`).then(data => setAttachments(Array.isArray(data) ? data : [])).catch(() => {});
  };

  useEffect(() => { loadContact(); loadAttachments(); }, [id]);

  const handleUpload = async (e) => {
    e.preventDefault();
    await fetchApi(`/api/contacts/${id}/attachments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(uploadForm)
    });
    setShowUpload(false);
    setUploadForm({ filename: '', fileUrl: '' });
    loadAttachments();
  };

  const handleDeleteAttachment = async (attachId) => {
    await fetchApi(`/api/contacts/attachments/${attachId}`, { method: 'DELETE' });
    loadAttachments();
  };

  if (!contact) return <div style={{ padding: '2rem' }}>Loading...</div>;

  const activities = contact.activities || [];

  return (
    <div style={{ padding: '2rem' }}>
      <Link to="/contacts" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', marginBottom: '1.5rem', textDecoration: 'none' }}>
        <ArrowLeft size={16} /> Back to Contacts
      </Link>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 1fr) 2fr', gap: '1.5rem' }}>
        {/* Profile Card */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="card glass" style={{ padding: '1.5rem' }}>
            <div style={{ width: '80px', height: '80px', borderRadius: '50%', backgroundColor: 'var(--accent-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '2rem', fontWeight: 'bold', marginBottom: '1rem', color: '#fff' }}>
              {contact.name.charAt(0)}
            </div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{contact.name}</h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>{contact.title} at {contact.company}</p>

            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <span style={{ padding: '0.2rem 0.6rem', borderRadius: '12px', fontSize: '0.7rem', fontWeight: '600', background: contact.status === 'Customer' ? 'rgba(16,185,129,0.1)' : contact.status === 'Lead' ? 'rgba(59,130,246,0.1)' : 'rgba(245,158,11,0.1)', color: contact.status === 'Customer' ? '#10b981' : contact.status === 'Lead' ? '#3b82f6' : '#f59e0b' }}>
                {contact.status}
              </span>
              <span style={{ padding: '0.2rem 0.6rem', borderRadius: '12px', fontSize: '0.7rem', fontWeight: '600', background: contact.aiScore > 70 ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.1)', color: contact.aiScore > 70 ? '#10b981' : '#f59e0b', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <Target size={10} /> {contact.aiScore}/100
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                <Mail size={14} /> {contact.email}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                <Phone size={14} /> {contact.phone || 'No phone number'}
              </div>
              {contact.source && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                  Source: {contact.source}
                </div>
              )}
            </div>

            {/* Deals */}
            {contact.deals && contact.deals.length > 0 && (
              <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1rem', marginTop: '1rem' }}>
                <h4 style={{ fontSize: '0.85rem', fontWeight: '600', marginBottom: '0.5rem' }}>Deals ({contact.deals.length})</h4>
                {contact.deals.map(d => (
                  <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.375rem 0', fontSize: '0.8rem' }}>
                    <span>{d.title}</span>
                    <span style={{ color: d.stage === 'won' ? '#10b981' : 'var(--text-secondary)' }}>${d.amount.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Attachments Card */}
          <div className="card glass" style={{ padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Paperclip size={16} /> Files ({attachments.length})
              </h3>
              <button onClick={() => setShowUpload(true)} style={{ background: 'none', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '0.3rem 0.6rem', cursor: 'pointer', color: 'var(--accent-color)', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <Upload size={12} /> Add
              </button>
            </div>
            {attachments.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>No files attached.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {attachments.map(a => (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
                    <FileText size={16} color="var(--accent-color)" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <a href={a.fileUrl} target="_blank" rel="noreferrer" style={{ fontSize: '0.8rem', fontWeight: '500', color: 'var(--text-primary)', textDecoration: 'none', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {a.filename}
                      </a>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{new Date(a.createdAt).toLocaleDateString()}</span>
                    </div>
                    <button onClick={() => handleDeleteAttachment(a.id)} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}><Trash2 size={12} /></button>
                  </div>
                ))}
              </div>
            )}

            {showUpload && (
              <form onSubmit={handleUpload} style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.75rem', background: 'var(--subtle-bg)', borderRadius: '6px' }}>
                <input className="input-field" placeholder="File name" required value={uploadForm.filename} onChange={e => setUploadForm({ ...uploadForm, filename: e.target.value })} style={{ padding: '0.4rem', fontSize: '0.8rem' }} />
                <input className="input-field" placeholder="File URL" required value={uploadForm.fileUrl} onChange={e => setUploadForm({ ...uploadForm, fileUrl: e.target.value })} style={{ padding: '0.4rem', fontSize: '0.8rem' }} />
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button type="submit" className="btn-primary" style={{ padding: '0.3rem 0.75rem', fontSize: '0.8rem' }}>Save</button>
                  <button type="button" onClick={() => setShowUpload(false)} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.8rem' }}>Cancel</button>
                </div>
              </form>
            )}
          </div>
        </div>

        {/* Activity Timeline */}
        <div className="card glass" style={{ padding: '1.5rem' }}>
          <h3 style={{ fontSize: '1.125rem', fontWeight: 'bold', marginBottom: '1.5rem' }}>Activity Timeline ({activities.length})</h3>

          {activities.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>No activities recorded yet.</p>
          ) : (
            <div style={{ borderLeft: '2px solid var(--border-color)', paddingLeft: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              {activities.map(act => {
                const dotColor = act.type === 'Email' ? '#3b82f6' : act.type === 'Call' ? '#f59e0b' : act.type === 'Meeting' ? '#8b5cf6' : '#10b981';
                return (
                  <div key={act.id} style={{ position: 'relative' }}>
                    <div style={{ position: 'absolute', left: '-1.85rem', top: '0.25rem', width: '12px', height: '12px', borderRadius: '50%', backgroundColor: dotColor }} />
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {new Date(act.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      <span style={{ marginLeft: '0.5rem', padding: '0.1rem 0.4rem', borderRadius: '4px', fontSize: '0.65rem', background: `${dotColor}22`, color: dotColor }}>{act.type}</span>
                    </p>
                    <p style={{ fontWeight: '500', fontSize: '0.9rem', marginTop: '0.25rem' }}>{act.description}</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ContactDetail;
