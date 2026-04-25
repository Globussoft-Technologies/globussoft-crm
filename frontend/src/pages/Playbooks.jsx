import React, { useState, useEffect, useMemo } from 'react';
import {
  FileText, Plus, Edit, Trash2, Check, GripVertical,
  Copy, X, Power, PowerOff, Target, ListChecks,
} from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const STAGES = [
  { value: 'lead',      label: 'Lead',      color: '#94a3b8' },
  { value: 'contacted', label: 'Contacted', color: '#3b82f6' },
  { value: 'proposal',  label: 'Proposal',  color: '#8b5cf6' },
  { value: 'won',       label: 'Won',       color: '#10b981' },
  { value: 'lost',      label: 'Lost',      color: '#ef4444' },
];

function stageMeta(stage) {
  return STAGES.find((s) => s.value === stage) || { value: stage, label: stage, color: '#64748b' };
}

const glassCard = {
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '14px',
  padding: '1.25rem',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
};

const inputStyle = {
  width: '100%',
  padding: '0.55rem 0.75rem',
  background: 'rgba(15,23,42,0.5)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: '8px',
  color: 'var(--text-primary, #e2e8f0)',
  fontSize: '0.9rem',
  boxSizing: 'border-box',
};

const buttonStyle = (variant = 'primary') => {
  const variants = {
    primary:   { bg: 'linear-gradient(135deg, #6366f1, #8b5cf6)', color: '#fff', border: 'transparent' },
    secondary: { bg: 'rgba(255,255,255,0.06)', color: '#e2e8f0', border: 'rgba(255,255,255,0.12)' },
    danger:    { bg: 'rgba(239,68,68,0.12)', color: '#ef4444', border: 'rgba(239,68,68,0.3)' },
    ghost:     { bg: 'transparent', color: '#94a3b8', border: 'rgba(255,255,255,0.08)' },
  };
  const v = variants[variant] || variants.primary;
  return {
    padding: '0.55rem 1rem', borderRadius: '8px', border: `1px solid ${v.border}`,
    background: v.bg, color: v.color, fontSize: '0.85rem', fontWeight: 600,
    cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
  };
};

function StageBadge({ stage }) {
  const m = stageMeta(stage);
  return (
    <span style={{
      padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.72rem',
      fontWeight: 700, color: m.color, border: `1px solid ${m.color}55`,
      background: `${m.color}1A`, textTransform: 'capitalize',
    }}>{m.label}</span>
  );
}

const EMPTY_FORM = { name: '', stage: 'lead', steps: [{ title: '', description: '' }], isActive: true };

export default function Playbooks() {
  const notify = useNotify();
  const [playbooks, setPlaybooks] = useState([]);
  const [stats, setStats] = useState(null);
  const [stageFilter, setStageFilter] = useState('');
  const [loading, setLoading] = useState(true);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [dragIndex, setDragIndex] = useState(null);

  const [deals, setDeals] = useState([]);
  const [selectedDealId, setSelectedDealId] = useState('');
  const [dealPlaybooks, setDealPlaybooks] = useState([]);

  useEffect(() => { loadAll(); }, []);
  useEffect(() => { loadPlaybooks(); }, [stageFilter]);
  useEffect(() => { if (selectedDealId) loadDealPlaybooks(); }, [selectedDealId]);

  const loadAll = async () => {
    setLoading(true);
    await Promise.all([loadPlaybooks(), loadStats(), loadDeals()]);
    setLoading(false);
  };

  const loadPlaybooks = async () => {
    try {
      const qs = stageFilter ? `?stage=${encodeURIComponent(stageFilter)}` : '';
      const data = await fetchApi(`/api/playbooks${qs}`);
      setPlaybooks(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('loadPlaybooks', err);
    }
  };

  const loadStats = async () => {
    try {
      const data = await fetchApi('/api/playbooks/stats');
      setStats(data || null);
    } catch (err) {
      console.error('loadStats', err);
    }
  };

  const loadDeals = async () => {
    try {
      const data = await fetchApi('/api/deals');
      setDeals(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('loadDeals', err);
    }
  };

  const loadDealPlaybooks = async () => {
    try {
      const data = await fetchApi(`/api/playbooks/deal/${selectedDealId}`);
      setDealPlaybooks(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('loadDealPlaybooks', err);
    }
  };

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY_FORM, steps: [{ title: '', description: '' }] });
    setEditorOpen(true);
  };

  const openEdit = (pb) => {
    setEditing(pb);
    setForm({
      name: pb.name || '',
      stage: pb.stage || 'lead',
      steps: (pb.steps && pb.steps.length ? pb.steps : [{ title: '', description: '' }])
        .map((s) => ({ title: s.title || '', description: s.description || '' })),
      isActive: !!pb.isActive,
    });
    setEditorOpen(true);
  };

  const closeEditor = () => { setEditorOpen(false); setEditing(null); };

  const savePlaybook = async () => {
    if (!form.name.trim()) { notify.error('Name is required'); return; }
    const cleanSteps = form.steps
      .filter((s) => (s.title || '').trim())
      .map((s, i) => ({ title: s.title.trim(), description: (s.description || '').trim(), order: i }));
    if (cleanSteps.length === 0) { notify.error('At least one step is required'); return; }
    const payload = { name: form.name.trim(), stage: form.stage, steps: cleanSteps, isActive: form.isActive };
    try {
      if (editing) {
        await fetchApi(`/api/playbooks/${editing.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await fetchApi('/api/playbooks', { method: 'POST', body: JSON.stringify(payload) });
      }
      closeEditor();
      loadAll();
    } catch (err) {
      console.error('save', err);
      notify.error('Failed to save playbook');
    }
  };

  const deletePlaybook = async (id) => {
    if (!await notify.confirm('Delete this playbook? Existing progress will be removed.')) return;
    try {
      await fetchApi(`/api/playbooks/${id}`, { method: 'DELETE' });
      loadAll();
    } catch (err) {
      notify.error('Failed to delete');
    }
  };

  const duplicatePlaybook = async (id) => {
    try {
      await fetchApi(`/api/playbooks/${id}/duplicate`, { method: 'POST' });
      loadAll();
    } catch (err) {
      notify.error('Failed to duplicate');
    }
  };

  const toggleActive = async (pb) => {
    try {
      await fetchApi(`/api/playbooks/${pb.id}`, {
        method: 'PUT', body: JSON.stringify({ isActive: !pb.isActive }),
      });
      loadAll();
    } catch (err) {
      notify.error('Failed to toggle');
    }
  };

  const updateStep = (idx, field, value) => {
    setForm((f) => {
      const steps = f.steps.slice();
      steps[idx] = { ...steps[idx], [field]: value };
      return { ...f, steps };
    });
  };

  const addStep = () => {
    setForm((f) => ({ ...f, steps: [...f.steps, { title: '', description: '' }] }));
  };

  const removeStep = (idx) => {
    setForm((f) => ({ ...f, steps: f.steps.filter((_, i) => i !== idx) }));
  };

  const onDragStart = (idx) => setDragIndex(idx);
  const onDragOver = (e) => e.preventDefault();
  const onDrop = (idx) => {
    if (dragIndex === null || dragIndex === idx) return;
    setForm((f) => {
      const steps = f.steps.slice();
      const [moved] = steps.splice(dragIndex, 1);
      steps.splice(idx, 0, moved);
      return { ...f, steps };
    });
    setDragIndex(null);
  };

  const toggleStepProgress = async (playbookId, stepIndex, currentlyDone) => {
    try {
      await fetchApi(`/api/playbooks/deal/${selectedDealId}/step`, {
        method: 'POST',
        body: JSON.stringify({ playbookId, stepIndex, completed: !currentlyDone }),
      });
      loadDealPlaybooks();
    } catch (err) {
      notify.error('Failed to update step');
    }
  };

  const filteredPlaybooks = useMemo(() => playbooks, [playbooks]);

  return (
    <div style={{ padding: '2rem', color: 'var(--text-primary, #e2e8f0)' }}>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <FileText size={28} color="#8b5cf6" />
          <div>
            <h1 style={{ margin: 0, fontSize: '1.6rem', fontWeight: 700 }}>Sales Playbooks</h1>
            <p style={{ margin: '0.25rem 0 0', color: '#94a3b8', fontSize: '0.85rem' }}>
              Guided steps for each deal stage to drive consistent sales execution.
            </p>
          </div>
        </div>
        <button style={buttonStyle('primary')} onClick={openCreate}>
          <Plus size={16} /> Create Playbook
        </button>
      </div>

      {/* Stats */}
      {stats && (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '1rem', marginBottom: '1.5rem',
        }}>
          <div style={glassCard}>
            <div style={{ color: '#94a3b8', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Total</div>
            <div style={{ fontSize: '1.6rem', fontWeight: 700, marginTop: '0.25rem' }}>{stats.total}</div>
          </div>
          <div style={glassCard}>
            <div style={{ color: '#10b981', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Active</div>
            <div style={{ fontSize: '1.6rem', fontWeight: 700, marginTop: '0.25rem' }}>{stats.active}</div>
          </div>
          <div style={glassCard}>
            <div style={{ color: '#94a3b8', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Inactive</div>
            <div style={{ fontSize: '1.6rem', fontWeight: 700, marginTop: '0.25rem' }}>{stats.inactive}</div>
          </div>
          <div style={glassCard}>
            <div style={{ color: '#94a3b8', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Stages Covered</div>
            <div style={{ fontSize: '1.6rem', fontWeight: 700, marginTop: '0.25rem' }}>{(stats.stages || []).length}</div>
          </div>
        </div>
      )}

      {/* Filter */}
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <label style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Filter by stage:</label>
        <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}
          style={{ ...inputStyle, width: 'auto', minWidth: '180px' }}>
          <option value="">All stages</option>
          {STAGES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>

      {/* Playbook grid */}
      {loading ? (
        <div style={{ ...glassCard, textAlign: 'center', color: '#94a3b8' }}>Loading playbooks...</div>
      ) : filteredPlaybooks.length === 0 ? (
        <div style={{ ...glassCard, textAlign: 'center', color: '#94a3b8' }}>
          No playbooks yet. Click "Create Playbook" to add one.
        </div>
      ) : (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1rem',
        }}>
          {filteredPlaybooks.map((pb) => (
            <div key={pb.id} style={{ ...glassCard, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: '1.05rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {pb.name}
                  </div>
                  <div style={{ marginTop: '0.4rem' }}><StageBadge stage={pb.stage} /></div>
                </div>
                <button
                  onClick={() => toggleActive(pb)}
                  title={pb.isActive ? 'Deactivate' : 'Activate'}
                  style={{
                    ...buttonStyle(pb.isActive ? 'secondary' : 'ghost'),
                    padding: '0.35rem 0.55rem',
                  }}
                >
                  {pb.isActive ? <Power size={14} color="#10b981" /> : <PowerOff size={14} />}
                </button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#94a3b8', fontSize: '0.85rem' }}>
                <ListChecks size={14} />
                {pb.steps?.length || 0} step{(pb.steps?.length || 0) === 1 ? '' : 's'}
              </div>

              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                <button style={buttonStyle('secondary')} onClick={() => openEdit(pb)}>
                  <Edit size={14} /> Edit
                </button>
                <button style={buttonStyle('secondary')} onClick={() => duplicatePlaybook(pb.id)}>
                  <Copy size={14} /> Duplicate
                </button>
                <button style={buttonStyle('danger')} onClick={() => deletePlaybook(pb.id)}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Apply to Deal */}
      <div style={{ ...glassCard, marginTop: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <Target size={18} color="#6366f1" />
          <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>Apply to Deal</h3>
        </div>
        <p style={{ color: '#94a3b8', fontSize: '0.85rem', marginTop: 0 }}>
          Select a deal to view its stage-matched playbooks and check off steps as you complete them.
        </p>

        <select
          value={selectedDealId}
          onChange={(e) => setSelectedDealId(e.target.value)}
          style={{ ...inputStyle, maxWidth: '420px', marginBottom: '1rem' }}
        >
          <option value="">Select a deal...</option>
          {deals.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title} — {d.stage}
            </option>
          ))}
        </select>

        {selectedDealId && (
          dealPlaybooks.length === 0 ? (
            <div style={{ color: '#94a3b8', fontStyle: 'italic' }}>
              No active playbooks match this deal's stage.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: '1rem' }}>
              {dealPlaybooks.map(({ playbook, progress }) => {
                const completed = new Set(progress?.completedSteps || []);
                return (
                  <div key={playbook.id} style={{
                    background: 'rgba(15,23,42,0.4)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    borderRadius: '10px',
                    padding: '1rem',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <div style={{ fontWeight: 700 }}>{playbook.name}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <StageBadge stage={playbook.stage} />
                        <span style={{
                          fontSize: '0.8rem', fontWeight: 700, color: '#10b981',
                          background: 'rgba(16,185,129,0.12)', padding: '0.2rem 0.55rem',
                          borderRadius: '999px', border: '1px solid rgba(16,185,129,0.3)',
                        }}>
                          {progress?.pctComplete ?? 0}%
                        </span>
                      </div>
                    </div>

                    <div style={{
                      height: '6px', background: 'rgba(255,255,255,0.06)', borderRadius: '4px',
                      overflow: 'hidden', marginBottom: '0.75rem',
                    }}>
                      <div style={{
                        width: `${progress?.pctComplete ?? 0}%`, height: '100%',
                        background: 'linear-gradient(90deg, #10b981, #34d399)', transition: 'width 0.3s ease',
                      }} />
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {(playbook.steps || []).map((step, idx) => {
                        const done = completed.has(idx);
                        return (
                          <div key={idx} style={{
                            display: 'flex', alignItems: 'flex-start', gap: '0.65rem',
                            padding: '0.55rem 0.7rem',
                            background: done ? 'rgba(16,185,129,0.06)' : 'rgba(255,255,255,0.02)',
                            border: `1px solid ${done ? 'rgba(16,185,129,0.2)' : 'rgba(255,255,255,0.05)'}`,
                            borderRadius: '8px',
                            cursor: 'pointer',
                          }}
                            onClick={() => toggleStepProgress(playbook.id, idx, done)}
                          >
                            <div style={{
                              width: '20px', height: '20px', borderRadius: '5px',
                              border: `1.5px solid ${done ? '#10b981' : 'rgba(255,255,255,0.2)'}`,
                              background: done ? '#10b981' : 'transparent',
                              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                              marginTop: '2px',
                            }}>
                              {done && <Check size={14} color="#fff" />}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{
                                fontWeight: 600, fontSize: '0.9rem',
                                textDecoration: done ? 'line-through' : 'none',
                                color: done ? '#94a3b8' : '#e2e8f0',
                              }}>
                                {step.title}
                              </div>
                              {step.description && (
                                <div style={{ color: '#94a3b8', fontSize: '0.8rem', marginTop: '0.2rem' }}>
                                  {step.description}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )
        )}
      </div>

      {/* Editor Modal */}
      {editorOpen && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000, padding: '1rem',
        }} onClick={closeEditor}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '14px', width: '100%', maxWidth: '640px', maxHeight: '90vh',
            overflow: 'auto', padding: '1.5rem',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700 }}>
                {editing ? 'Edit Playbook' : 'Create Playbook'}
              </h2>
              <button style={{ ...buttonStyle('ghost'), padding: '0.35rem' }} onClick={closeEditor}>
                <X size={16} />
              </button>
            </div>

            <div style={{ display: 'grid', gap: '0.85rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.3rem' }}>Name</label>
                <input style={inputStyle} value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g., Discovery Call Playbook" />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.3rem' }}>Stage</label>
                <select style={inputStyle} value={form.stage}
                  onChange={(e) => setForm((f) => ({ ...f, stage: e.target.value }))}>
                  {STAGES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>

              <div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', color: '#cbd5e1' }}>
                  <input type="checkbox" checked={form.isActive}
                    onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} />
                  Active
                </label>
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <label style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Steps (drag to reorder)</label>
                  <button style={buttonStyle('secondary')} onClick={addStep}>
                    <Plus size={14} /> Add Step
                  </button>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {form.steps.map((step, idx) => (
                    <div key={idx}
                      draggable
                      onDragStart={() => onDragStart(idx)}
                      onDragOver={onDragOver}
                      onDrop={() => onDrop(idx)}
                      style={{
                        display: 'flex', gap: '0.5rem', alignItems: 'flex-start',
                        background: 'rgba(15,23,42,0.6)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: '8px', padding: '0.6rem',
                      }}>
                      <div style={{ cursor: 'grab', color: '#64748b', paddingTop: '0.4rem' }}>
                        <GripVertical size={16} />
                      </div>
                      <div style={{ flex: 1, display: 'grid', gap: '0.4rem' }}>
                        <input style={inputStyle} placeholder={`Step ${idx + 1} title`}
                          value={step.title}
                          onChange={(e) => updateStep(idx, 'title', e.target.value)} />
                        <textarea style={{ ...inputStyle, minHeight: '50px', resize: 'vertical' }}
                          placeholder="Description (optional)"
                          value={step.description}
                          onChange={(e) => updateStep(idx, 'description', e.target.value)} />
                      </div>
                      <button style={{ ...buttonStyle('danger'), padding: '0.4rem' }}
                        onClick={() => removeStep(idx)}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button style={buttonStyle('secondary')} onClick={closeEditor}>Cancel</button>
                <button style={buttonStyle('primary')} onClick={savePlaybook}>
                  <Check size={14} /> {editing ? 'Save Changes' : 'Create Playbook'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
