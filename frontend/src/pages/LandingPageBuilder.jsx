import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Save, Eye, Globe, Monitor, Smartphone, Plus, Trash2, ChevronUp, ChevronDown, Type, AlignLeft, Image, MousePointerClick, FileInput, Minus, Space, Video, Columns } from 'lucide-react';
import { fetchApi } from '../utils/api';

const COMPONENT_TYPES = [
  { type: 'heading', label: 'Heading', icon: Type, defaultProps: { text: 'Your Headline Here', level: 'h2', align: 'center', color: '#1e293b' } },
  { type: 'text', label: 'Text', icon: AlignLeft, defaultProps: { text: 'Enter your text content here.', align: 'left', color: '#64748b', fontSize: '1rem' } },
  { type: 'image', label: 'Image', icon: Image, defaultProps: { src: 'https://placehold.co/800x400/e2e8f0/94a3b8?text=Image', alt: 'Image', maxWidth: '100%' } },
  { type: 'button', label: 'Button', icon: MousePointerClick, defaultProps: { text: 'Click Here', url: '#', bgColor: '#3b82f6', color: '#ffffff', align: 'center', size: 'medium' } },
  { type: 'form', label: 'Form', icon: FileInput, defaultProps: { fields: [{ label: 'Name', name: 'name', type: 'text', required: true }, { label: 'Email', name: 'email', type: 'email', required: true }], submitText: 'Submit', thankYouMessage: 'Thank you!' } },
  { type: 'divider', label: 'Divider', icon: Minus, defaultProps: { color: '#e2e8f0', margin: '1rem' } },
  { type: 'spacer', label: 'Spacer', icon: Space, defaultProps: { height: '40px' } },
  { type: 'video', label: 'Video', icon: Video, defaultProps: { url: 'https://www.youtube.com/embed/dQw4w9WgXcQ', width: '100%' } },
];

export default function LandingPageBuilder() {
  const { id } = useParams();
  const [page, setPage] = useState(null);
  const [components, setComponents] = useState([]);
  const [selected, setSelected] = useState(null);
  const [saving, setSaving] = useState(false);
  const [previewMode, setPreviewMode] = useState('desktop');

  useEffect(() => {
    fetchApi(`/api/landing-pages/${id}`).then(data => {
      setPage(data);
      try { setComponents(JSON.parse(data.content || '[]')); } catch { setComponents([]); }
    }).catch(() => {});
  }, [id]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetchApi(`/api/landing-pages/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: page.title, content: JSON.stringify(components) })
      });
    } catch { alert('Save failed'); }
    setSaving(false);
  };

  const addComponent = (type) => {
    const def = COMPONENT_TYPES.find(t => t.type === type);
    setComponents([...components, { id: Date.now().toString(), type, props: { ...def.defaultProps } }]);
  };

  const updateProp = (compId, key, value) => {
    setComponents(components.map(c => c.id === compId ? { ...c, props: { ...c.props, [key]: value } } : c));
  };

  const moveComponent = (idx, dir) => {
    const newComps = [...components];
    const swap = idx + dir;
    if (swap < 0 || swap >= newComps.length) return;
    [newComps[idx], newComps[swap]] = [newComps[swap], newComps[idx]];
    setComponents(newComps);
  };

  const removeComponent = (idx) => {
    setComponents(components.filter((_, i) => i !== idx));
    setSelected(null);
  };

  const selectedComp = selected !== null ? components[selected] : null;
  if (!page) return <div style={{ padding: '2rem' }}>Loading...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* Top Bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.75rem 1.5rem', borderBottom: '1px solid var(--border-color)', flexShrink: 0 }}>
        <Link to="/landing-pages" style={{ color: 'var(--text-secondary)', display: 'flex', alignItems: 'center' }}><ArrowLeft size={18} /></Link>
        <input className="input-field" value={page.title} onChange={e => setPage({ ...page, title: e.target.value })} style={{ fontWeight: '600', fontSize: '1rem', padding: '0.375rem 0.75rem', width: '250px' }} />
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: '0.25rem', background: 'var(--subtle-bg)', borderRadius: '6px', padding: '0.2rem' }}>
          <button onClick={() => setPreviewMode('desktop')} style={{ padding: '0.3rem 0.6rem', borderRadius: '4px', border: 'none', cursor: 'pointer', background: previewMode === 'desktop' ? 'var(--accent-color)' : 'transparent', color: previewMode === 'desktop' ? '#fff' : 'var(--text-secondary)' }}><Monitor size={14} /></button>
          <button onClick={() => setPreviewMode('mobile')} style={{ padding: '0.3rem 0.6rem', borderRadius: '4px', border: 'none', cursor: 'pointer', background: previewMode === 'mobile' ? 'var(--accent-color)' : 'transparent', color: previewMode === 'mobile' ? '#fff' : 'var(--text-secondary)' }}><Smartphone size={14} /></button>
        </div>
        {page.status === 'PUBLISHED' && (
          <a href={`${window.location.origin.replace(':5173', ':5000')}/p/${page.slug}`} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.4rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '0.85rem', color: 'var(--text-primary)', textDecoration: 'none' }}>
            <Eye size={14} /> Preview
          </a>
        )}
        <button className="btn-primary" onClick={handleSave} disabled={saving} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.4rem 1rem', fontSize: '0.85rem' }}>
          <Save size={14} /> {saving ? 'Saving...' : 'Save'}
        </button>
      </div>

      {/* Three Panel Layout */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left: Component Palette */}
        <div style={{ width: '200px', borderRight: '1px solid var(--border-color)', padding: '1rem', overflowY: 'auto', flexShrink: 0 }}>
          <h4 style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '0.75rem' }}>Components</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
            {COMPONENT_TYPES.map(ct => (
              <button key={ct.type} onClick={() => addComponent(ct.type)} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.75rem', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'none', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.85rem', transition: 'all 0.15s' }}>
                <ct.icon size={14} /> {ct.label}
              </button>
            ))}
          </div>
        </div>

        {/* Center: Preview Canvas */}
        <div style={{ flex: 1, overflowY: 'auto', background: 'var(--subtle-bg)', padding: '2rem', display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: previewMode === 'mobile' ? '375px' : '100%', maxWidth: '800px', background: 'var(--surface-color)', borderRadius: '8px', boxShadow: 'var(--glass-shadow)', padding: '2rem', minHeight: '400px' }}>
            {components.length === 0 && (
              <div style={{ textAlign: 'center', padding: '4rem 2rem', color: '#94a3b8' }}>
                <Plus size={48} style={{ opacity: 0.3, marginBottom: '1rem' }} />
                <p>Click components on the left to add them</p>
              </div>
            )}
            {components.map((comp, idx) => (
              <div key={comp.id} onClick={() => setSelected(idx)} style={{ position: 'relative', border: selected === idx ? '2px solid #3b82f6' : '2px solid transparent', borderRadius: '4px', padding: '0.25rem', margin: '0.25rem 0', cursor: 'pointer', transition: 'border-color 0.15s' }}>
                {selected === idx && (
                  <div style={{ position: 'absolute', top: '-1px', right: '-1px', display: 'flex', gap: '0.125rem', zIndex: 10, background: '#3b82f6', borderRadius: '0 4px 0 4px', padding: '0.125rem' }}>
                    <button onClick={e => { e.stopPropagation(); moveComponent(idx, -1); }} style={iconBtnStyle}><ChevronUp size={12} /></button>
                    <button onClick={e => { e.stopPropagation(); moveComponent(idx, 1); }} style={iconBtnStyle}><ChevronDown size={12} /></button>
                    <button onClick={e => { e.stopPropagation(); removeComponent(idx); }} style={iconBtnStyle}><Trash2 size={12} /></button>
                  </div>
                )}
                <ComponentPreview comp={comp} />
              </div>
            ))}
          </div>
        </div>

        {/* Right: Property Editor */}
        <div style={{ width: '280px', borderLeft: '1px solid var(--border-color)', padding: '1rem', overflowY: 'auto', flexShrink: 0 }}>
          {selectedComp ? (
            <>
              <h4 style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '0.75rem' }}>
                {selectedComp.type.toUpperCase()} PROPERTIES
              </h4>
              <PropertyEditor comp={selectedComp} updateProp={(k, v) => updateProp(selectedComp.id, k, v)} />
            </>
          ) : (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', padding: '1rem 0' }}>Select a component to edit its properties</p>
          )}
        </div>
      </div>
    </div>
  );
}

const iconBtnStyle = { background: 'none', border: 'none', color: '#fff', cursor: 'pointer', padding: '2px' };

function ComponentPreview({ comp }) {
  const p = comp.props;
  switch (comp.type) {
    case 'heading': { const Tag = p.level || 'h2'; return <Tag style={{ textAlign: p.align, color: p.color, margin: '0.5rem 0' }}>{p.text}</Tag>; }
    case 'text': return <p style={{ textAlign: p.align, color: p.color, fontSize: p.fontSize, margin: '0.5rem 0', lineHeight: 1.6 }}>{p.text}</p>;
    case 'image': return <div style={{ textAlign: 'center' }}><img src={p.src} alt={p.alt} style={{ maxWidth: p.maxWidth || '100%', borderRadius: '6px', height: 'auto' }} /></div>;
    case 'button': return <div style={{ textAlign: p.align }}><button style={{ padding: p.size === 'large' ? '1rem 2.5rem' : '0.75rem 1.5rem', background: p.bgColor, color: p.color, border: 'none', borderRadius: '6px', fontWeight: '600', fontSize: p.size === 'large' ? '1.1rem' : '1rem', cursor: 'pointer' }}>{p.text}</button></div>;
    case 'form': return (
      <div style={{ maxWidth: '400px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {(p.fields || []).map((f, i) => (
          <div key={i}><label style={{ display: 'block', fontSize: '0.85rem', fontWeight: '500', marginBottom: '0.25rem', color: '#475569' }}>{f.label}{f.required && ' *'}</label>
          <input type={f.type} style={{ width: '100%', padding: '0.6rem', border: '1px solid #cbd5e1', borderRadius: '6px' }} disabled /></div>
        ))}
        <button style={{ padding: '0.75rem', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '6px', fontWeight: '600' }}>{p.submitText}</button>
      </div>
    );
    case 'divider': return <hr style={{ border: 'none', borderTop: `1px solid ${p.color}`, margin: p.margin }} />;
    case 'spacer': return <div style={{ height: p.height }} />;
    case 'video': return <div style={{ textAlign: 'center' }}><iframe src={p.url} style={{ width: p.width || '100%', maxWidth: '100%', height: '360px', border: 'none', borderRadius: '6px' }} allowFullScreen /></div>;
    default: return <div style={{ padding: '1rem', background: 'var(--subtle-bg)', borderRadius: '6px', fontSize: '0.85rem' }}>Unknown: {comp.type}</div>;
  }
}

function PropertyEditor({ comp, updateProp }) {
  const p = comp.props;
  const field = (label, key, type = 'text') => (
    <div key={key} style={{ marginBottom: '0.75rem' }}>
      <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>{label}</label>
      {type === 'textarea' ? (
        <textarea className="input-field" value={p[key] || ''} onChange={e => updateProp(key, e.target.value)} rows={3} style={{ width: '100%', padding: '0.4rem', fontSize: '0.85rem', resize: 'vertical' }} />
      ) : type === 'select' ? null : (
        <input className="input-field" type={type} value={p[key] || ''} onChange={e => updateProp(key, e.target.value)} style={{ width: '100%', padding: '0.4rem', fontSize: '0.85rem' }} />
      )}
    </div>
  );

  const selectField = (label, key, options) => (
    <div key={key} style={{ marginBottom: '0.75rem' }}>
      <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>{label}</label>
      <select className="input-field" value={p[key] || ''} onChange={e => updateProp(key, e.target.value)} style={{ width: '100%', padding: '0.4rem', fontSize: '0.85rem' }}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );

  switch (comp.type) {
    case 'heading': return <>{field('Text', 'text')}{selectField('Level', 'level', ['h1','h2','h3','h4','h5','h6'])}{selectField('Align', 'align', ['left','center','right'])}{field('Color', 'color', 'color')}</>;
    case 'text': return <>{field('Content', 'text', 'textarea')}{selectField('Align', 'align', ['left','center','right'])}{field('Color', 'color', 'color')}{field('Font Size', 'fontSize')}</>;
    case 'image': return <>{field('Image URL', 'src')}{field('Alt Text', 'alt')}{field('Max Width', 'maxWidth')}</>;
    case 'button': return <>{field('Button Text', 'text')}{field('URL', 'url')}{field('Background', 'bgColor', 'color')}{field('Text Color', 'color', 'color')}{selectField('Align', 'align', ['left','center','right'])}{selectField('Size', 'size', ['small','medium','large'])}</>;
    case 'form': return (
      <>
        <p style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.5rem' }}>Form Fields:</p>
        {(p.fields || []).map((f, i) => (
          <div key={i} style={{ display: 'flex', gap: '0.25rem', marginBottom: '0.375rem', alignItems: 'center' }}>
            <input className="input-field" value={f.label} onChange={e => { const flds = [...p.fields]; flds[i] = { ...flds[i], label: e.target.value }; updateProp('fields', flds); }} style={{ flex: 1, padding: '0.3rem', fontSize: '0.8rem' }} />
            <button onClick={() => { const flds = p.fields.filter((_, j) => j !== i); updateProp('fields', flds); }} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}><Trash2 size={12} /></button>
          </div>
        ))}
        <button onClick={() => updateProp('fields', [...(p.fields || []), { label: 'New Field', name: 'field_' + Date.now(), type: 'text', required: false }])} style={{ fontSize: '0.75rem', color: 'var(--accent-color)', background: 'none', border: 'none', cursor: 'pointer', marginBottom: '0.75rem' }}>+ Add Field</button>
        {field('Submit Text', 'submitText')}
        {field('Thank You Message', 'thankYouMessage')}
      </>
    );
    case 'divider': return <>{field('Color', 'color', 'color')}{field('Margin', 'margin')}</>;
    case 'spacer': return <>{field('Height', 'height')}</>;
    case 'video': return <>{field('Embed URL', 'url')}{field('Width', 'width')}</>;
    default: return <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>No properties for this component.</p>;
  }
}
