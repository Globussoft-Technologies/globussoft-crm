import React, { useState, useEffect } from 'react';
import { X, FileText, UploadCloud, Download, FileSignature } from 'lucide-react';
import { fetchApi } from '../utils/api';
import CPQBuilder from './CPQBuilder';

const API_BASE = "";

export default function DealModal({ deal, onClose }) {
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [notes, setNotes] = useState(deal?.notes || '');
  const [savingNote, setSavingNote] = useState(false);

  const handleSaveNote = async () => {
    setSavingNote(true);
    try {
      await fetchApi(`/api/deals/${deal.id}`, { method: 'PUT', body: JSON.stringify({ notes }) });
      setTimeout(() => setSavingNote(false), 500);
    } catch(err) {
      console.error(err);
      setSavingNote(false);
    }
  };

  useEffect(() => {
    if (deal) {
      loadAttachments();
    }
  }, [deal]);

  const loadAttachments = async () => {
    try {
      const data = await fetchApi(`/api/deals_documents/${deal.id}/attachments`);
      setAttachments(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
    }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    setUploading(true);
    const formData = new FormData();
    formData.append('file', file);
    
    try {
      const token = localStorage.getItem('token');
      await fetch(`${API_BASE}/api/deals_documents/${deal.id}/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });
      await loadAttachments();
    } catch (err) {
      console.error("Upload failed", err);
    }
    setUploading(false);
  };

  const handleGenerateQuote = async () => {
    setGenerating(true);
    try {
      await fetchApi(`/api/deals_documents/${deal.id}/generate-quote`, { method: 'POST' });
      await loadAttachments();
    } catch (err) {
      console.error("Quote gen failed", err);
    }
    setGenerating(false);
  };

  if (!deal) return null;

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(10px)', zIndex: 9999, display: 'flex', justifyContent: 'center', alignItems: 'center', animation: 'fadeIn 0.2s ease-out' }} onClick={onClose}>
      <div 
        className="card modal"
        role="dialog" 
        style={{ width: '800px', height: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', border: '1px solid var(--border-color)', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.8)' }} 
        onClick={e => e.stopPropagation()}
      >
        <header style={{ padding: '2rem', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--subtle-bg-2)' }}>
          <div>
            <h2 style={{ fontSize: '1.75rem', fontWeight: 'bold' }}>{deal.title}</h2>
            <p style={{ color: 'var(--text-secondary)' }}>{deal.company} • ${(deal.amount || 0).toLocaleString()} • Stage: {deal.stage.toUpperCase()}</p>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', transition: 'color 0.2s' }}>
            <X size={24} />
          </button>
        </header>

        <div style={{ padding: '2rem', display: 'flex', gap: '2rem', flex: 1, overflowY: 'auto' }}>
          
          {/* Main Info Pane */}
          <div style={{ flex: 1 }}>
            <h3 style={{ fontSize: '1.25rem', marginBottom: '1.5rem', fontWeight: 'bold' }}>Document Center</h3>
            
            <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem' }}>
              <button onClick={handleGenerateQuote} disabled={generating} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, justifyContent: 'center' }}>
                <FileSignature size={18} /> {generating ? 'Generating PDF...' : 'Generate Quote'}
              </button>
              
              <label className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, justifyContent: 'center', cursor: 'pointer', margin: 0 }}>
                <UploadCloud size={18} /> {uploading ? 'Uploading...' : 'Upload File'}
                <input type="file" style={{ display: 'none' }} onChange={handleFileUpload} />
              </label>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {attachments.length === 0 && <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem', border: '1px dashed var(--border-color)', borderRadius: '12px' }}>No documents attached to this deal.</p>}
              {attachments.map(att => (
                <div key={att.id} style={{ padding: '1rem', border: '1px solid var(--border-color)', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--subtle-bg-2)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <div style={{ width: '40px', height: '40px', borderRadius: '8px', background: 'rgba(59, 130, 246, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3b82f6' }}>
                      <FileText size={20} />
                    </div>
                    <div>
                      <p style={{ fontWeight: '600' }}>{att.filename}</p>
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{new Date(att.createdAt).toLocaleDateString()}</p>
                    </div>
                  </div>
                  <a href={`${API_BASE}${att.fileUrl}`} target="_blank" rel="noreferrer" className="btn-secondary" style={{ padding: '0.5rem 1rem', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Download size={16} /> Open
                  </a>
                </div>
              ))}
            </div>

            <CPQBuilder dealId={deal.id} />
            
            <div style={{ marginTop: '2rem', background: 'var(--subtle-bg-2)', padding: '1.5rem', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
              <h3 style={{ fontSize: '1.25rem', marginBottom: '1rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <FileText size={20} color="var(--accent-color)" /> Deal Notes & Tasks
              </h3>
              <textarea 
                className="input-field" 
                rows={4} 
                placeholder="Log a call, meeting, or general note here..." 
                value={notes}
                onChange={e => setNotes(e.target.value)}
                style={{ resize: 'vertical', marginBottom: '1rem' }}
              />
              <button className="btn-secondary" onClick={handleSaveNote} disabled={savingNote}>
                {savingNote ? 'Saving...' : 'Save Note'}
              </button>
            </div>
          </div>

          {/* Side Pane */}
          <div style={{ width: '250px', borderLeft: '1px solid var(--border-color)', paddingLeft: '2rem' }}>
            <h4 style={{ color: 'var(--text-secondary)', textTransform: 'uppercase', fontSize: '0.75rem', letterSpacing: '0.05em', marginBottom: '1rem' }}>Deal Properties</h4>
            <div style={{ marginBottom: '1.5rem' }}>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Probability Score</p>
              <p style={{ fontWeight: 'bold' }}>{deal.probability}%</p>
            </div>
            <div style={{ marginBottom: '1.5rem' }}>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Close Date</p>
              <p style={{ fontWeight: 'bold' }}>{deal.expectedClose ? new Date(deal.expectedClose).toLocaleDateString() : 'Not Set'}</p>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
