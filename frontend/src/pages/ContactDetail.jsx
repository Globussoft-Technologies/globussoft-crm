import { fetchApi } from '../utils/api';
import { formatMoney } from '../utils/money';
import { formatDate, formatDateTime } from '../utils/date';
import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Phone, Mail, Calendar, Paperclip, Upload, Trash2, FileText, Download, Target, Pencil, MessageSquareText, Sparkles } from 'lucide-react';

const ContactDetail = () => {
  const { id } = useParams();
  const [contact, setContact] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadForm, setUploadForm] = useState({ filename: '', fileUrl: '' });
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState('');
  const [editForm, setEditForm] = useState({ name: '', email: '', phone: '', company: '', title: '' });

  const openEdit = () => {
    setEditForm({
      name: contact.name || '',
      email: contact.email || '',
      phone: contact.phone || '',
      company: contact.company || '',
      title: contact.title || '',
    });
    setEditError('');
    setEditing(true);
  };

  const handleSaveEdit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setEditError('');
    try {
      await fetchApi(`/api/contacts/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm),
      });
      setEditing(false);
      loadContact();
    } catch (err) {
      setEditError(err?.message || 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  };

  const loadContact = () => {
    fetchApi(`/api/contacts/${id}`).then(data => setContact(data)).catch(() => {});
  };

  const [summarizing, setSummarizing] = useState(false);
  const [summarizeError, setSummarizeError] = useState('');
  const handleSummarizeChat = async () => {
    setSummarizing(true);
    setSummarizeError('');
    try {
      await fetchApi(`/api/contacts/${id}/summarize-chat`, { method: 'POST', body: JSON.stringify({}) });
      loadContact();
    } catch (err) {
      setSummarizeError(err?.data?.error || err?.body?.error || err?.message || 'Failed to summarize chat.');
    } finally {
      setSummarizing(false);
    }
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
          <div className="card glass" style={{ padding: '1.5rem', position: 'relative' }}>
            {!editing && (
              <button onClick={openEdit} title="Edit contact" style={{ position: 'absolute', top: '1rem', right: '1rem', background: 'none', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '0.3rem 0.6rem', cursor: 'pointer', color: 'var(--accent-color)', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <Pencil size={12} /> Edit
              </button>
            )}
            <div style={{ width: '80px', height: '80px', borderRadius: '50%', backgroundColor: 'var(--accent-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '2rem', fontWeight: 'bold', marginBottom: '1rem', color: '#fff' }}>
              {contact.name.charAt(0)}
            </div>
            {editing ? (
              <form onSubmit={handleSaveEdit} style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                <label style={{ fontSize: '0.7rem', fontWeight: '600', color: 'var(--text-secondary)' }}>Name
                  <input className="input-field" required value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })} style={{ padding: '0.45rem', fontSize: '0.85rem', marginTop: '0.2rem' }} />
                </label>
                <label style={{ fontSize: '0.7rem', fontWeight: '600', color: 'var(--text-secondary)' }}>Email
                  <input className="input-field" type="email" value={editForm.email} onChange={e => setEditForm({ ...editForm, email: e.target.value })} style={{ padding: '0.45rem', fontSize: '0.85rem', marginTop: '0.2rem' }} />
                </label>
                <label style={{ fontSize: '0.7rem', fontWeight: '600', color: 'var(--text-secondary)' }}>Phone
                  <input className="input-field" value={editForm.phone} onChange={e => setEditForm({ ...editForm, phone: e.target.value })} style={{ padding: '0.45rem', fontSize: '0.85rem', marginTop: '0.2rem' }} />
                </label>
                <label style={{ fontSize: '0.7rem', fontWeight: '600', color: 'var(--text-secondary)' }}>Company
                  <input className="input-field" value={editForm.company} onChange={e => setEditForm({ ...editForm, company: e.target.value })} style={{ padding: '0.45rem', fontSize: '0.85rem', marginTop: '0.2rem' }} />
                </label>
                <label style={{ fontSize: '0.7rem', fontWeight: '600', color: 'var(--text-secondary)' }}>Title
                  <input className="input-field" value={editForm.title} onChange={e => setEditForm({ ...editForm, title: e.target.value })} style={{ padding: '0.45rem', fontSize: '0.85rem', marginTop: '0.2rem' }} />
                </label>
                {editError && <p style={{ color: '#ef4444', fontSize: '0.75rem', margin: 0 }}>{editError}</p>}
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                  <button type="submit" className="btn-primary" disabled={saving} style={{ padding: '0.4rem 0.9rem', fontSize: '0.8rem' }}>{saving ? 'Saving…' : 'Save'}</button>
                  <button type="button" onClick={() => setEditing(false)} disabled={saving} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.8rem' }}>Cancel</button>
                </div>
              </form>
            ) : (
            <>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{contact.name}</h2>
            {/* #189B: skip the "at <company>" subtitle when company/title are empty
                so we don't render an orphan preposition. */}
            {(contact.title || contact.company) && (
              <p style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                {contact.title}
                {contact.title && contact.company ? ' at ' : ''}
                {contact.company}
              </p>
            )}

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

            {/* AI-generated chat summary — append-only via "Sync Lead" on the
                WhatsApp thread, or fully regenerated as one narrative here.
                Shown whenever the contact already has a summary OR came in
                through any WhatsApp-flavoured source (direct auto-capture
                "whatsapp" or multichannel intake "inbound:whatsapp").
                The manual "Summarize" (re-summarize-from-scratch) button is
                WhatsApp-specific — POST /:id/summarize-chat only ever reads
                WhatsAppMessage rows (lib/leadConversationSummary.js), so it
                404/409s with a WhatsApp-flavoured error message for any other
                source (gmail, whatsapp-extension, etc). Those sources already
                got their one-time summary written into description at
                capture time (routes/leads_extension_capture.js) — there's no
                raw message log behind them to re-summarize from, so the
                button is hidden rather than shown-and-broken. */}
            {(contact.description || /whatsapp/i.test(contact.source || '')) && (
              <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1rem', marginTop: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem', gap: '0.5rem' }}>
                  <h4 style={{ fontSize: '0.85rem', fontWeight: '600', margin: 0, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <MessageSquareText size={14} /> Chat Summary
                  </h4>
                  {/^whatsapp$/i.test(contact.source || '') || contact.source === 'inbound:whatsapp' ? (
                    <button
                      type="button"
                      onClick={handleSummarizeChat}
                      disabled={summarizing}
                      className="btn-secondary"
                      title="Regenerate a full narrative summary from the entire WhatsApp history"
                      style={{ fontSize: '0.75rem', padding: '0.3rem 0.65rem', display: 'flex', alignItems: 'center', gap: 4 }}
                    >
                      <Sparkles size={13} /> {summarizing ? 'Summarizing…' : 'Summarize'}
                    </button>
                  ) : null}
                </div>
                {summarizeError && (
                  <p style={{ color: '#ef4444', fontSize: '0.75rem', margin: '0 0 0.5rem' }}>{summarizeError}</p>
                )}
                {contact.description ? (
                  <pre style={{
                    margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    fontFamily: 'inherit', fontSize: '0.8rem', lineHeight: 1.6,
                    color: 'var(--text-secondary)', maxHeight: 360, overflowY: 'auto',
                  }}>
                    {contact.description}
                  </pre>
                ) : (
                  <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    No summary yet — click Summarize to generate one from the WhatsApp history.
                  </p>
                )}
              </div>
            )}

            {/* Deals */}
            {contact.deals && contact.deals.length > 0 && (
              <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1rem', marginTop: '1rem' }}>
                <h4 style={{ fontSize: '0.85rem', fontWeight: '600', marginBottom: '0.5rem' }}>Deals ({contact.deals.length})</h4>
                {contact.deals.map(d => (
                  <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.375rem 0', fontSize: '0.8rem' }}>
                    <span>{d.title}</span>
                    {/* #189A: deals carry their own currency; format with that
                        instead of hardcoding "$". formatMoney falls back to
                        tenant default when no currency override is provided. */}
                    <span style={{ color: d.stage === 'won' ? '#10b981' : 'var(--text-secondary)' }}>{formatMoney(d.amount, { currency: d.currency })}</span>
                  </div>
                ))}
              </div>
            )}
            </>
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
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{formatDate(a.createdAt)}</span>
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
                const dotColor = act.type === 'Email' ? '#3b82f6' : act.type === 'Call' ? '#f59e0b' : act.type === 'Meeting' ? '#8b5cf6' : act.type === 'Booking' ? '#14b8a6' : act.type === 'Invoice' ? '#eab308' : '#10b981';
                return (
                  <div key={act.id} style={{ position: 'relative' }}>
                    <div style={{ position: 'absolute', left: '-1.85rem', top: '0.25rem', width: '12px', height: '12px', borderRadius: '50%', backgroundColor: dotColor }} />
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {formatDateTime(act.createdAt)}
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
