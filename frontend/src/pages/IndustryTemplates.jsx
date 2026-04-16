import React, { useState, useEffect } from 'react';
import {
  Building2,
  Home,
  Heart,
  GraduationCap,
  Scale,
  Cloud,
  Check,
  Plus,
  X,
  Workflow,
  Database,
  Users,
  Sparkles,
  AlertTriangle,
} from 'lucide-react';
import { fetchApi } from '../utils/api';

const INDUSTRY_ICONS = {
  'real-estate': Home,
  healthcare: Heart,
  education: GraduationCap,
  legal: Scale,
  saas: Cloud,
};

const INDUSTRY_ACCENTS = {
  'real-estate': '#10b981',
  healthcare: '#ef4444',
  education: '#6366f1',
  legal: '#f59e0b',
  saas: '#06b6d4',
};

export default function IndustryTemplates() {
  const [templates, setTemplates] = useState([]);
  const [pipelines, setPipelines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirmTemplate, setConfirmTemplate] = useState(null);
  const [applying, setApplying] = useState(false);
  const [toast, setToast] = useState(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [tpls, pipes] = await Promise.all([
        fetchApi('/api/industry-templates'),
        fetchApi('/api/pipelines').catch(() => []),
      ]);
      setTemplates(Array.isArray(tpls) ? tpls : []);
      setPipelines(Array.isArray(pipes) ? pipes : []);
    } catch (e) {
      setError(e.message || 'Failed to load industry templates');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const isAlreadyApplied = (tpl) => {
    if (!tpl?.config?.pipelines || pipelines.length === 0) return false;
    const existingNames = new Set(pipelines.map((p) => (p.name || '').toLowerCase()));
    return tpl.config.pipelines.every((p) => existingNames.has(p.name.toLowerCase()));
  };

  const handleApply = async () => {
    if (!confirmTemplate) return;
    setApplying(true);
    try {
      const result = await fetchApi(`/api/industry-templates/apply/${confirmTemplate.industry}`, {
        method: 'POST',
      });
      setConfirmTemplate(null);
      setToast({
        type: 'success',
        title: `${confirmTemplate.name} applied`,
        message: `Created ${result.created.pipelines} pipelines, ${result.created.stages} stages, ${result.created.customEntities} custom objects, and ${result.created.contacts} sample contacts.`,
      });
      // refresh pipelines so "Already Applied" shows
      load();
    } catch (e) {
      setToast({
        type: 'error',
        title: 'Failed to apply template',
        message: e.message || 'Unknown error',
      });
    } finally {
      setApplying(false);
    }
  };

  // auto-dismiss toast after 6s
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      {/* Header */}
      <header style={{ marginBottom: '2rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <Building2 size={26} style={{ color: 'var(--accent-color)' }} />
        <div>
          <h2 style={{ fontSize: '1.6rem', fontWeight: 'bold' }}>Industry Templates</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '0.25rem' }}>
            Jump-start your CRM with pre-built pipelines, custom objects, and sample data tuned to your industry.
          </p>
        </div>
      </header>

      {error && (
        <div
          className="card"
          style={{
            padding: '1rem 1.25rem',
            marginBottom: '1.25rem',
            color: '#ef4444',
            borderLeft: '3px solid #ef4444',
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          Loading industry templates...
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: '1.25rem',
          }}
        >
          {templates.map((tpl) => (
            <TemplateCard
              key={tpl.id || tpl.industry}
              template={tpl}
              applied={isAlreadyApplied(tpl)}
              onApply={() => setConfirmTemplate(tpl)}
            />
          ))}
          {templates.length === 0 && (
            <div
              className="card"
              style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)', gridColumn: '1 / -1' }}
            >
              No industry templates available.
            </div>
          )}
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmTemplate && (
        <ConfirmModal
          template={confirmTemplate}
          applying={applying}
          onCancel={() => !applying && setConfirmTemplate(null)}
          onConfirm={handleApply}
        />
      )}

      {/* Toast */}
      {toast && (
        <div
          style={{
            position: 'fixed',
            top: '1.5rem',
            right: '1.5rem',
            zIndex: 300,
            maxWidth: 380,
            background: 'var(--card-bg, rgba(20, 20, 30, 0.85))',
            border: `1px solid ${toast.type === 'error' ? '#ef4444' : '#10b981'}`,
            borderLeft: `4px solid ${toast.type === 'error' ? '#ef4444' : '#10b981'}`,
            backdropFilter: 'blur(12px)',
            borderRadius: 10,
            padding: '1rem 1.25rem',
            boxShadow: '0 10px 30px rgba(0,0,0,0.3)',
            animation: 'fadeIn 0.25s ease',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.625rem' }}>
            <div style={{ color: toast.type === 'error' ? '#ef4444' : '#10b981', marginTop: 2 }}>
              {toast.type === 'error' ? <AlertTriangle size={18} /> : <Check size={18} />}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{toast.title}</div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{toast.message}</div>
              {toast.type === 'success' && (
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.625rem' }}>
                  <a
                    href="/pipelines"
                    style={{
                      fontSize: '0.8rem',
                      padding: '0.3rem 0.625rem',
                      background: 'var(--accent-color)',
                      color: '#fff',
                      borderRadius: 6,
                      textDecoration: 'none',
                      fontWeight: 600,
                    }}
                  >
                    View Pipelines
                  </a>
                  <a
                    href="/objects"
                    style={{
                      fontSize: '0.8rem',
                      padding: '0.3rem 0.625rem',
                      background: 'var(--bg-secondary)',
                      color: 'var(--text-primary)',
                      borderRadius: 6,
                      textDecoration: 'none',
                      fontWeight: 600,
                      border: '1px solid var(--border-color)',
                    }}
                  >
                    View Custom Objects
                  </a>
                </div>
              )}
            </div>
            <button
              onClick={() => setToast(null)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
function TemplateCard({ template, applied, onApply }) {
  const Icon = INDUSTRY_ICONS[template.industry] || Building2;
  const accent = INDUSTRY_ACCENTS[template.industry] || '#3b82f6';
  const config = template.config || {};
  const pipelineCount = (config.pipelines || []).length;
  const stageCount = (config.pipelines || []).reduce(
    (acc, p) => acc + (p.stages || []).length,
    0
  );
  const customObjectCount = (config.customFields || []).length;
  const sampleContactCount = (config.sampleContacts || []).length;

  return (
    <div
      className="card"
      style={{
        padding: '1.5rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
        position: 'relative',
        borderTop: `3px solid ${accent}`,
      }}
    >
      {applied && (
        <div
          style={{
            position: 'absolute',
            top: '0.75rem',
            right: '0.75rem',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.25rem',
            background: 'rgba(16, 185, 129, 0.15)',
            color: '#10b981',
            border: '1px solid rgba(16, 185, 129, 0.4)',
            borderRadius: 999,
            padding: '0.2rem 0.6rem',
            fontSize: '0.7rem',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          <Check size={12} /> Already Applied
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            background: `${accent}22`,
            color: accent,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon size={22} />
        </div>
        <div>
          <h3 style={{ fontWeight: 700, fontSize: '1.05rem' }}>{template.name}</h3>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {template.industry}
          </div>
        </div>
      </div>

      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', lineHeight: 1.45, minHeight: 56 }}>
        {template.description}
      </p>

      <div
        style={{
          background: 'var(--bg-secondary)',
          borderRadius: 8,
          padding: '0.75rem 0.875rem',
          fontSize: '0.8rem',
        }}
      >
        <div
          style={{
            fontSize: '0.7rem',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            color: 'var(--text-secondary)',
            marginBottom: '0.5rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.25rem',
          }}
        >
          <Sparkles size={12} /> What's Included
        </div>
        <div style={{ display: 'grid', gap: '0.375rem' }}>
          <IncludedRow icon={<Workflow size={13} />} label={`${pipelineCount} pipeline${pipelineCount === 1 ? '' : 's'}, ${stageCount} stages`} />
          <IncludedRow icon={<Database size={13} />} label={`${customObjectCount} custom object${customObjectCount === 1 ? '' : 's'}`} />
          <IncludedRow icon={<Users size={13} />} label={`${sampleContactCount} sample contact${sampleContactCount === 1 ? '' : 's'}`} />
        </div>

        {(config.pipelines || []).length > 0 && (
          <div style={{ marginTop: '0.625rem', paddingTop: '0.625rem', borderTop: '1px solid var(--border-color)' }}>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Pipelines</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
              {config.pipelines.map((p) => (
                <span
                  key={p.name}
                  style={{
                    fontSize: '0.7rem',
                    padding: '0.15rem 0.5rem',
                    background: 'var(--card-bg, rgba(255,255,255,0.06))',
                    borderRadius: 999,
                    border: '1px solid var(--border-color)',
                  }}
                >
                  {p.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {(config.customFields || []).length > 0 && (
          <div style={{ marginTop: '0.5rem' }}>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Custom Objects</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
              {config.customFields.map((ce) => (
                <span
                  key={ce.entity}
                  style={{
                    fontSize: '0.7rem',
                    padding: '0.15rem 0.5rem',
                    background: 'var(--card-bg, rgba(255,255,255,0.06))',
                    borderRadius: 999,
                    border: '1px solid var(--border-color)',
                  }}
                >
                  {ce.entity}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <button
        className={applied ? '' : 'btn-primary'}
        onClick={onApply}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.375rem',
          padding: '0.6rem 1rem',
          fontSize: '0.875rem',
          fontWeight: 600,
          marginTop: 'auto',
          ...(applied
            ? {
                background: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: 8,
                cursor: 'pointer',
              }
            : {}),
        }}
      >
        <Plus size={15} /> {applied ? 'Re-Apply Template' : 'Apply Template'}
      </button>
    </div>
  );
}

function IncludedRow({ icon, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', color: 'var(--text-primary)' }}>
      <span style={{ color: 'var(--text-secondary)' }}>{icon}</span>
      <span>{label}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
function ConfirmModal({ template, applying, onCancel, onConfirm }) {
  const config = template.config || {};
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--overlay-bg, rgba(0,0,0,0.6))',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 250,
      }}
    >
      <div className="card" style={{ padding: '1.75rem', width: 480, maxWidth: '92vw' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ fontWeight: 'bold', fontSize: '1.15rem' }}>Apply {template.name}?</h3>
          <button
            onClick={onCancel}
            style={{ background: 'none', border: 'none', cursor: applying ? 'not-allowed' : 'pointer', color: 'var(--text-secondary)' }}
            disabled={applying}
          >
            <X size={18} />
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            gap: '0.625rem',
            background: 'rgba(245, 158, 11, 0.12)',
            border: '1px solid rgba(245, 158, 11, 0.4)',
            borderRadius: 8,
            padding: '0.75rem 0.875rem',
            marginBottom: '1rem',
            fontSize: '0.85rem',
            color: 'var(--text-primary)',
          }}
        >
          <AlertTriangle size={16} style={{ color: '#f59e0b', flexShrink: 0, marginTop: 2 }} />
          <div>
            This will <strong>add</strong> new pipelines, pipeline stages, custom objects, and sample contacts to your tenant.
            Existing data with the same names will be skipped — nothing will be deleted.
          </div>
        </div>

        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
          You will create:
        </div>
        <ul style={{ marginLeft: '1.25rem', marginBottom: '1.25rem', fontSize: '0.85rem', lineHeight: 1.7 }}>
          {(config.pipelines || []).map((p) => (
            <li key={p.name}>
              Pipeline <strong>{p.name}</strong> ({(p.stages || []).length} stages)
            </li>
          ))}
          {(config.customFields || []).map((ce) => (
            <li key={ce.entity}>
              Custom object <strong>{ce.entity}</strong> ({(ce.fields || []).length} fields)
            </li>
          ))}
          {(config.sampleContacts || []).length > 0 && (
            <li>
              {(config.sampleContacts || []).length} sample contact{(config.sampleContacts || []).length === 1 ? '' : 's'}
            </li>
          )}
        </ul>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
          <button
            onClick={onCancel}
            disabled={applying}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: applying ? 'not-allowed' : 'pointer',
              padding: '0.5rem 0.875rem',
            }}
          >
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={onConfirm}
            disabled={applying}
            style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1rem' }}
          >
            {applying ? 'Applying...' : (<><Check size={15} /> Apply Template</>)}
          </button>
        </div>
      </div>
    </div>
  );
}
