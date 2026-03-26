import React, { useState } from 'react';
import { Copy, Code, Layout, Blocks, CheckCircle2 } from 'lucide-react';

export default function Marketing() {
  const [formName, setFormName] = useState('My Contact Form');
  const [fields, setFields] = useState([{ id: 1, type: 'text', label: 'Full Name', name: 'full_name', required: true }]);
  const [copied, setCopied] = useState(false);

  // Hardcode base API for snippet (In production this relies on window.location or process.env)
  const API_ENDPOINT = 'http://localhost:5000/api/marketing/submit';

  const embedCode = `<form action="${API_ENDPOINT}" method="POST" style="display: flex; flex-direction: column; gap: 1rem; font-family: sans-serif; max-width: 400px; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);">
  <h3 style="margin: 0; font-size: 1.25rem; font-weight: 600; color: #1e293b;">${formName}</h3>
  <input type="hidden" name="formId" value="form_${Date.now()}" />
${fields.map(f => `  <div style="display: flex; flex-direction: column; gap: 0.25rem;">
    <label style="font-size: 0.875rem; font-weight: 500; color: #475569;">${f.label}</label>
    <input type="${f.type}" name="${f.name}" ${f.required ? 'required' : ''} style="padding: 0.75rem; border: 1px solid #cbd5e1; border-radius: 0.375rem; outline: none;" />
  </div>`).join('\n')}
  <button type="submit" style="margin-top: 0.5rem; padding: 0.75rem; background-color: #3b82f6; color: white; font-weight: 600; border: none; border-radius: 0.375rem; cursor: pointer;">Submit Request</button>
</form>`;

  const copyToClipboard = () => {
    navigator.clipboard.writeText(embedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const addField = () => {
    setFields([...fields, { id: Date.now(), type: 'email', label: 'Email Address', name: 'email', required: true }]);
  };

  return (
    <div style={{ padding: '2rem', height: '100%', display: 'flex', flexDirection: 'column', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2.5rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 'bold' }}>Marketing Forms</h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Build lead capture forms and embed them natively on your website.</p>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem', flex: 1, minHeight: 0 }}>
        
        {/* Builder View */}
        <div className="card" style={{ padding: '2rem', overflowY: 'auto' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Layout size={20} color="var(--accent-color)" /> Builder
          </h3>
          
          <div style={{ marginBottom: '2rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Form Name</label>
            <input type="text" className="input-field" value={formName} onChange={e => setFormName(e.target.value)} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '2rem' }}>
            <h4 style={{ fontSize: '1rem', fontWeight: '600' }}>Fields</h4>
            {fields.map((field, idx) => (
              <div key={field.id} style={{ display: 'flex', gap: '1rem', alignItems: 'center', background: 'rgba(255,255,255,0.02)', padding: '1rem', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                <div style={{ width: '24px', height: '24px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem' }}>{idx + 1}</div>
                <input type="text" className="input-field" value={field.label} onChange={e => {
                  const newFields = [...fields];
                  newFields[idx].label = e.target.value;
                  setFields(newFields);
                }} style={{ margin: 0, flex: 1 }} />
                <select className="input-field" value={field.name} onChange={e => {
                  const newFields = [...fields];
                  newFields[idx].name = e.target.value;
                  setFields(newFields);
                }} style={{ margin: 0, width: '150px' }}>
                  <option value="full_name" style={{ background: '#0f172a' }}>Full Name</option>
                  <option value="email" style={{ background: '#0f172a' }}>Email</option>
                  <option value="company_name" style={{ background: '#0f172a' }}>Company</option>
                  <option value="phone" style={{ background: '#0f172a' }}>Phone</option>
                </select>
                <button 
                  onClick={() => setFields(fields.filter(f => f.id !== field.id))}
                  style={{ background: 'transparent', border: 'none', color: 'var(--danger-color)', cursor: 'pointer', fontWeight: 'bold' }}
                >
                  Remove
                </button>
              </div>
            ))}
            <button className="btn-secondary" onClick={addField} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'center', padding: '1rem', borderStyle: 'dashed' }}>
              <Blocks size={18} /> Add Form Field
            </button>
          </div>
        </div>

        {/* Output View */}
        <div className="card" style={{ padding: '2rem', display: 'flex', flexDirection: 'column', background: '#0f172a', border: '1px solid rgba(59, 130, 246, 0.3)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
            <h3 style={{ fontSize: '1.25rem', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Code size={20} color="#3b82f6" /> Embed Snippet
            </h3>
            <button className={copied ? "btn-success" : "btn-primary"} onClick={copyToClipboard} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: copied ? 'var(--success-color)' : '' }}>
              {copied ? <CheckCircle2 size={16} /> : <Copy size={16} />} {copied ? 'Copied!' : 'Copy Snippet'}
            </button>
          </div>
          
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
            Paste this HTML snippet directly into your website (Wordpress, Webflow, Shopify). Submissions will automatically sync to your pipeline.
          </p>
          
          <div style={{ flex: 1, background: '#1e293b', borderRadius: '8px', padding: '1rem', overflow: 'auto', position: 'relative' }}>
            <pre style={{ margin: 0, color: '#e2e8f0', fontSize: '0.875rem', fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              <code>{embedCode}</code>
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
