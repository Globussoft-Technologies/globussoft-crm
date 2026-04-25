import React, { useState, useEffect } from 'react';
import { PanelTop, Plus, Eye, Copy, Trash2, Globe, FileEdit, BarChart3 } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { Link, useNavigate } from 'react-router-dom';

const STATUS_COLORS = { DRAFT: { bg: 'rgba(59,130,246,0.1)', color: '#3b82f6' }, PUBLISHED: { bg: 'rgba(16,185,129,0.1)', color: '#10b981' }, ARCHIVED: { bg: 'rgba(107,114,128,0.1)', color: '#6b7280' } };

export default function LandingPages() {
  const notify = useNotify();
  const [pages, setPages] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const navigate = useNavigate();

  const loadPages = () => {
    setLoading(true);
    fetchApi('/api/landing-pages').then(data => { setPages(Array.isArray(data) ? data : []); setLoading(false); }).catch(() => setLoading(false));
  };

  useEffect(() => {
    loadPages();
    fetchApi('/api/landing-pages/templates/list').then(data => setTemplates(data || [])).catch(() => {});
  }, []);

  const handleCreate = async (templateType) => {
    try {
      const tmpl = templates.find(t => t.id === templateType);
      const page = await fetchApi('/api/landing-pages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: tmpl?.name || 'Untitled Page', templateType, content: tmpl ? JSON.stringify(tmpl.content) : '[]' })
      });
      setShowTemplatePicker(false);
      navigate(`/landing-pages/builder/${page.id}`);
    } catch { notify.error('Failed to create page'); }
  };

  const handlePublish = async (id, action) => {
    await fetchApi(`/api/landing-pages/${id}/${action}`, { method: 'POST' });
    loadPages();
  };

  const handleDuplicate = async (id) => {
    await fetchApi(`/api/landing-pages/${id}/duplicate`, { method: 'POST' });
    loadPages();
  };

  const handleDelete = async (id) => {
    if (!await notify.confirm('Delete this landing page?')) return;
    await fetchApi(`/api/landing-pages/${id}`, { method: 'DELETE' });
    loadPages();
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <PanelTop size={24} style={{ color: 'var(--accent-color)' }} />
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Landing Pages</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Build no-code landing pages to capture leads</p>
          </div>
        </div>
        <button className="btn-primary" onClick={() => setShowTemplatePicker(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Plus size={18} /> Create Page
        </button>
      </header>

      {loading ? <p style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>Loading...</p> : pages.length === 0 ? (
        <div className="card" style={{ padding: '4rem', textAlign: 'center' }}>
          <PanelTop size={48} style={{ color: 'var(--text-secondary)', opacity: 0.3, marginBottom: '1rem' }} />
          <h3 style={{ marginBottom: '0.5rem' }}>No landing pages yet</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>Create your first landing page from a template to start capturing leads.</p>
          <button className="btn-primary" onClick={() => setShowTemplatePicker(true)}><Plus size={16} style={{ marginRight: '0.375rem', verticalAlign: 'middle' }} /> Create Page</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1.5rem' }}>
          {pages.map(page => {
            const sc = STATUS_COLORS[page.status] || STATUS_COLORS.DRAFT;
            const convRate = page.visits > 0 ? ((page.submissions / page.visits) * 100).toFixed(1) : 0;
            return (
              <div key={page.id} className="card" style={{ padding: '1.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
                  <h3 style={{ fontWeight: '600', fontSize: '1.1rem', flex: 1 }}>{page.title}</h3>
                  <span style={{ padding: '0.2rem 0.6rem', borderRadius: '4px', fontSize: '0.7rem', fontWeight: '600', background: sc.bg, color: sc.color }}>{page.status}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem', marginBottom: '1.25rem' }}>
                  <div style={{ textAlign: 'center', padding: '0.5rem', background: 'var(--subtle-bg)', borderRadius: '6px' }}>
                    <div style={{ fontSize: '1.25rem', fontWeight: '600' }}>{page.visits}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Visits</div>
                  </div>
                  <div style={{ textAlign: 'center', padding: '0.5rem', background: 'var(--subtle-bg)', borderRadius: '6px' }}>
                    <div style={{ fontSize: '1.25rem', fontWeight: '600' }}>{page.submissions}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Leads</div>
                  </div>
                  <div style={{ textAlign: 'center', padding: '0.5rem', background: 'var(--subtle-bg)', borderRadius: '6px' }}>
                    <div style={{ fontSize: '1.25rem', fontWeight: '600', color: '#10b981' }}>{convRate}%</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Conv.</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <Link to={`/landing-pages/builder/${page.id}`} className="btn-primary" style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.25rem', textDecoration: 'none' }}>
                    <FileEdit size={13} /> Edit
                  </Link>
                  {page.status === 'PUBLISHED' && (
                    <a href={`${window.location.origin.replace(':5173', ':5000')}/p/${page.slug}`} target="_blank" rel="noreferrer" style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.25rem', border: '1px solid var(--border-color)', borderRadius: '6px', textDecoration: 'none', color: 'var(--text-primary)' }}>
                      <Eye size={13} /> View
                    </a>
                  )}
                  <button onClick={() => handlePublish(page.id, page.status === 'PUBLISHED' ? 'unpublish' : 'publish')} style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.25rem', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'none', color: page.status === 'PUBLISHED' ? '#f59e0b' : '#10b981', cursor: 'pointer' }}>
                    <Globe size={13} /> {page.status === 'PUBLISHED' ? 'Unpublish' : 'Publish'}
                  </button>
                  <button onClick={() => handleDuplicate(page.id)} style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                    <Copy size={13} />
                  </button>
                  <button onClick={() => handleDelete(page.id)} style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'none', color: '#ef4444', cursor: 'pointer' }}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Template Picker Modal */}
      {showTemplatePicker && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
          <div className="card" style={{ padding: '2rem', width: '700px', maxHeight: '80vh', overflowY: 'auto' }}>
            <h3 style={{ fontWeight: 'bold', marginBottom: '1.5rem', fontSize: '1.25rem' }}>Choose a Template</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              {templates.map(t => (
                <div key={t.id} onClick={() => handleCreate(t.id)} className="card" style={{ padding: '1.25rem', cursor: 'pointer', border: '2px solid transparent', transition: 'all 0.2s' }} onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent-color)'} onMouseLeave={e => e.currentTarget.style.borderColor = 'transparent'}>
                  <div style={{ width: '100%', height: '80px', background: 'var(--subtle-bg)', borderRadius: '6px', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <PanelTop size={32} style={{ color: 'var(--text-secondary)', opacity: 0.3 }} />
                  </div>
                  <h4 style={{ fontWeight: '600', marginBottom: '0.25rem' }}>{t.name}</h4>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{t.description}</p>
                </div>
              ))}
              <div onClick={() => handleCreate('blank')} className="card" style={{ padding: '1.25rem', cursor: 'pointer', border: '2px dashed var(--border-color)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '150px' }}>
                <Plus size={32} style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }} />
                <h4 style={{ fontWeight: '600' }}>Blank Page</h4>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>Start from scratch</p>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.5rem' }}>
              <button onClick={() => setShowTemplatePicker(false)} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
