import React, { useState, useEffect } from 'react';
import { GitBranch, Plus, Edit, Trash2, Check, ExternalLink, Star, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const emptyForm = { name: '', description: '', isDefault: false };

const Pipelines = () => {
  const notify = useNotify();
  const [pipelines, setPipelines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null); // null = create, object = edit
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const fetchPipelines = () => {
    setLoading(true);
    fetchApi('/api/pipelines')
      .then((data) => {
        setPipelines(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message || 'Failed to load pipelines');
        setLoading(false);
      });
  };

  useEffect(() => { fetchPipelines(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setError('');
    setShowModal(true);
  };

  const openEdit = (p) => {
    setEditing(p);
    setForm({ name: p.name || '', description: p.description || '', isDefault: !!p.isDefault });
    setError('');
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditing(null);
    setForm(emptyForm);
    setError('');
  };

  const handleSave = async () => {
    if (!form.name.trim()) { setError('Pipeline name is required'); return; }
    setSaving(true);
    setError('');
    try {
      if (editing) {
        await fetchApi(`/api/pipelines/${editing.id}`, {
          method: 'PUT',
          body: JSON.stringify({ name: form.name, description: form.description }),
        });
        // If user toggled default ON during edit, fire set-default separately
        if (form.isDefault && !editing.isDefault) {
          await fetchApi(`/api/pipelines/${editing.id}/set-default`, { method: 'POST' });
        }
      } else {
        await fetchApi('/api/pipelines', {
          method: 'POST',
          body: JSON.stringify(form),
        });
      }
      closeModal();
      fetchPipelines();
    } catch (e) {
      setError(e.message || 'Save failed');
    }
    setSaving(false);
  };

  const handleSetDefault = async (id) => {
    try {
      await fetchApi(`/api/pipelines/${id}/set-default`, { method: 'POST' });
      fetchPipelines();
    } catch (e) {
      notify.error(e.message || 'Failed to set default');
    }
  };

  const handleDelete = async (p) => {
    if (!await notify.confirm({
      title: 'Delete pipeline',
      message: `Delete pipeline "${p.name}"? This cannot be undone.`,
      confirmText: 'Delete',
      destructive: true,
    })) return;
    try {
      await fetchApi(`/api/pipelines/${p.id}`, { method: 'DELETE' });
      fetchPipelines();
    } catch (e) {
      notify.error(e.message || 'Delete failed');
    }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      {/* Header */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <GitBranch size={24} style={{ color: 'var(--accent-color)' }} />
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Sales Pipelines</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              Manage multiple deal pipelines for different sales workflows.
            </p>
          </div>
        </div>
        <button
          className="btn-primary"
          onClick={openCreate}
          style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.375rem' }}
        >
          <Plus size={15} /> Create Pipeline
        </button>
      </header>

      {/* Body */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>Loading pipelines...</div>
      ) : pipelines.length === 0 ? (
        <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>
          <GitBranch size={48} style={{ color: 'var(--text-secondary)', opacity: 0.3, marginBottom: '1rem' }} />
          <h3 style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>No pipelines yet</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1rem' }}>
            Create your first sales pipeline to organize deals by workflow.
          </p>
          <button className="btn-primary" onClick={openCreate} style={{ padding: '0.5rem 1.25rem' }}>
            <Plus size={15} style={{ marginRight: '0.375rem', verticalAlign: 'middle' }} /> Create Pipeline
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1.25rem' }}>
          {pipelines.map((p) => (
            <div key={p.id} className="card" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', minWidth: 0 }}>
                  <GitBranch size={20} style={{ color: 'var(--accent-color)', flexShrink: 0 }} />
                  <h3 style={{ fontSize: '1.05rem', fontWeight: '600', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.name}
                  </h3>
                </div>
                {p.isDefault && (
                  <span style={{
                    padding: '0.2rem 0.5rem',
                    borderRadius: '4px',
                    fontSize: '0.7rem',
                    fontWeight: '600',
                    background: 'rgba(16, 185, 129, 0.1)',
                    color: '#10b981',
                    border: '1px solid rgba(16, 185, 129, 0.3)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                    flexShrink: 0,
                  }}>
                    <Star size={11} fill="#10b981" /> Default
                  </span>
                )}
              </div>

              <p style={{
                fontSize: '0.85rem',
                color: 'var(--text-secondary)',
                margin: 0,
                minHeight: '2.4em',
                lineHeight: 1.4,
              }}>
                {p.description || <span style={{ opacity: 0.5 }}>No description</span>}
              </p>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem' }}>
                <span style={{
                  padding: '0.25rem 0.625rem',
                  background: 'var(--subtle-bg)',
                  borderRadius: '999px',
                  fontWeight: '500',
                }}>
                  {p.dealCount || 0} {p.dealCount === 1 ? 'deal' : 'deals'}
                </span>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', borderTop: '1px solid var(--border-color)', paddingTop: '0.875rem' }}>
                <a
                  href={`/pipeline?pipelineId=${p.id}`}
                  className="btn-primary"
                  style={{
                    padding: '0.4rem 0.75rem',
                    fontSize: '0.8rem',
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                  }}
                >
                  <ExternalLink size={13} /> View Pipeline
                </a>
                <button
                  onClick={() => openEdit(p)}
                  title="Edit"
                  style={iconBtn}
                >
                  <Edit size={13} /> Edit
                </button>
                {!p.isDefault && (
                  <button
                    onClick={() => handleSetDefault(p.id)}
                    title="Set as default"
                    style={{ ...iconBtn, color: '#10b981', borderColor: 'rgba(16, 185, 129, 0.3)', background: 'rgba(16, 185, 129, 0.08)' }}
                  >
                    <Check size={13} /> Set Default
                  </button>
                )}
                {!p.isDefault && (
                  <button
                    onClick={() => handleDelete(p)}
                    title="Delete"
                    style={{ ...iconBtn, color: '#ef4444', borderColor: 'rgba(239, 68, 68, 0.3)', background: 'rgba(239, 68, 68, 0.08)' }}
                  >
                    <Trash2 size={13} /> Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div
          onClick={closeModal}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, backdropFilter: 'blur(4px)',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="card"
            style={{ width: '90%', maxWidth: '480px', padding: '1.75rem' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                <GitBranch size={20} style={{ color: 'var(--accent-color)' }} />
                <h3 style={{ fontSize: '1.15rem', fontWeight: '600', margin: 0 }}>
                  {editing ? 'Edit Pipeline' : 'Create Pipeline'}
                </h3>
              </div>
              <button onClick={closeModal} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
                <X size={20} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={labelStyle}>Pipeline Name *</label>
                <input
                  className="input-field"
                  style={inputStyle}
                  type="text"
                  placeholder="e.g. Enterprise Sales"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  autoFocus
                />
              </div>

              <div>
                <label style={labelStyle}>Description</label>
                <textarea
                  className="input-field"
                  style={{ ...inputStyle, minHeight: '80px', resize: 'vertical' }}
                  placeholder="Describe what this pipeline is for"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.875rem' }}>
                <input
                  type="checkbox"
                  checked={form.isDefault}
                  onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
                  disabled={editing && editing.isDefault}
                />
                <span>Set as default pipeline</span>
              </label>

              {error && (
                <div style={{
                  padding: '0.625rem 0.875rem',
                  borderRadius: '6px',
                  background: 'rgba(239, 68, 68, 0.1)',
                  color: '#ef4444',
                  fontSize: '0.85rem',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                }}>
                  {error}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.625rem', marginTop: '0.5rem' }}>
                <button
                  onClick={closeModal}
                  style={{
                    padding: '0.5rem 1rem',
                    borderRadius: '6px',
                    border: '1px solid var(--border-color)',
                    background: 'transparent',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    fontSize: '0.875rem',
                  }}
                >
                  Cancel
                </button>
                <button
                  className="btn-primary"
                  onClick={handleSave}
                  disabled={saving}
                  style={{ padding: '0.5rem 1.25rem', fontSize: '0.875rem', opacity: saving ? 0.7 : 1 }}
                >
                  {saving ? 'Saving...' : (editing ? 'Save Changes' : 'Create Pipeline')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const iconBtn = {
  padding: '0.4rem 0.625rem',
  borderRadius: '6px',
  border: '1px solid var(--border-color)',
  background: 'transparent',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  fontSize: '0.8rem',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.3rem',
};

const labelStyle = {
  display: 'block',
  fontSize: '0.8rem',
  fontWeight: '500',
  marginBottom: '0.375rem',
  color: 'var(--text-secondary)',
};

const inputStyle = {
  width: '100%',
  padding: '0.5rem 0.75rem',
  fontSize: '0.875rem',
};

export default Pipelines;
