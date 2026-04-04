import React, { useState, useEffect } from 'react';
import { Copy, Code, Layout, Blocks, CheckCircle2, Megaphone, Plus, BarChart, Send, MousePointerClick } from 'lucide-react';
import { fetchApi } from '../utils/api';

export default function Marketing() {
  const [activeTab, setActiveTab] = useState('campaigns'); // 'campaigns', 'forms', 'sms', 'push'
  
  // Forms State
  const [formName, setFormName] = useState('My Contact Form');
  const [fields, setFields] = useState([{ id: 1, type: 'text', label: 'Full Name', name: 'full_name', required: true }]);
  const [copied, setCopied] = useState(false);
  const API_ENDPOINT = '/api/marketing/submit';

  // Campaigns State
  const [campaigns, setCampaigns] = useState([]);
  const [showCreateCampaign, setShowCreateCampaign] = useState(false);
  const [newCampaignName, setNewCampaignName] = useState('');
  
  useEffect(() => {
    if (activeTab === 'campaigns') loadCampaigns();
  }, [activeTab]);

  const loadCampaigns = async () => {
    try {
      const data = await fetchApi('/api/marketing/campaigns');
      setCampaigns(Array.isArray(data) ? data : []);
    } catch(err) {
      console.error(err);
    }
  };

  const handleCreateCampaign = async (e) => {
    e.preventDefault();
    if (!newCampaignName) return;
    try {
      await fetchApi('/api/marketing/campaigns', {
        method: 'POST',
        body: JSON.stringify({ name: newCampaignName, budget: 0 })
      });
      setNewCampaignName('');
      setShowCreateCampaign(false);
      loadCampaigns();
    } catch (err) {
      alert("Failed to create campaign");
    }
  };

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
      <header style={{ marginBottom: '2.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold' }}>Marketing</h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Manage outbound campaigns and inbound lead capture forms.</p>
        </div>
        
        <div style={{ display: 'flex', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '0.25rem' }}>
          <button onClick={() => setActiveTab('campaigns')} style={{ padding: '0.5rem 1rem', borderRadius: '6px', border: 'none', cursor: 'pointer', background: activeTab === 'campaigns' ? 'var(--primary-color)' : 'transparent', color: activeTab === 'campaigns' ? '#fff' : 'var(--text-secondary)', fontWeight: activeTab === 'campaigns' ? '600' : '400' }}>Email Campaigns</button>
          <button onClick={() => setActiveTab('sms')} style={{ padding: '0.5rem 1rem', borderRadius: '6px', border: 'none', cursor: 'pointer', background: activeTab === 'sms' ? '#10b981' : 'transparent', color: activeTab === 'sms' ? '#fff' : 'var(--text-secondary)', fontWeight: activeTab === 'sms' ? '600' : '400' }}>SMS Campaigns</button>
          <button onClick={() => setActiveTab('push')} style={{ padding: '0.5rem 1rem', borderRadius: '6px', border: 'none', cursor: 'pointer', background: activeTab === 'push' ? '#8b5cf6' : 'transparent', color: activeTab === 'push' ? '#fff' : 'var(--text-secondary)', fontWeight: activeTab === 'push' ? '600' : '400' }}>Push Campaigns</button>
          <button onClick={() => setActiveTab('forms')} style={{ padding: '0.5rem 1rem', borderRadius: '6px', border: 'none', cursor: 'pointer', background: activeTab === 'forms' ? 'var(--primary-color)' : 'transparent', color: activeTab === 'forms' ? '#fff' : 'var(--text-secondary)', fontWeight: activeTab === 'forms' ? '600' : '400' }}>Embedded Forms</button>
        </div>
      </header>

      {activeTab === 'campaigns' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1.5rem' }}>
            <button className="btn-primary" onClick={() => setShowCreateCampaign(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Plus size={18} /> Create Campaign
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))', gap: '1.5rem' }}>
            {campaigns.map(camp => (
              <div key={camp.id} className="card campaign-card" style={{ padding: '1.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div style={{ background: 'rgba(59, 130, 246, 0.1)', padding: '0.6rem', borderRadius: '8px', color: '#3b82f6' }}>
                      <Megaphone size={20} />
                    </div>
                    <h3 style={{ fontSize: '1.125rem', fontWeight: 'bold' }}>{camp.name}</h3>
                  </div>
                  <span style={{ fontSize: '0.75rem', padding: '0.2rem 0.6rem', background: 'var(--subtle-bg-3)', borderRadius: '12px' }}>{camp.status}</span>
                </div>
                
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginTop: '1.5rem' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', background: 'var(--table-header-bg)', padding: '0.75rem', borderRadius: '8px' }}>
                    <Send size={16} color="var(--text-secondary)" style={{ marginBottom: '0.25rem' }}/>
                    <span style={{ fontSize: '1.25rem', fontWeight: '600' }}>{camp.sent}</span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Sent</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', background: 'var(--table-header-bg)', padding: '0.75rem', borderRadius: '8px' }}>
                    <BarChart size={16} color="var(--text-secondary)" style={{ marginBottom: '0.25rem' }}/>
                    <span style={{ fontSize: '1.25rem', fontWeight: '600' }}>{camp.opened}%</span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Open Rate</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', background: 'var(--table-header-bg)', padding: '0.75rem', borderRadius: '8px' }}>
                    <MousePointerClick size={16} color="var(--text-secondary)" style={{ marginBottom: '0.25rem' }}/>
                    <span style={{ fontSize: '1.25rem', fontWeight: '600' }}>{camp.clicked}%</span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Click Rate</span>
                  </div>
                </div>
              </div>
            ))}
            
            {campaigns.length === 0 && (
              <div style={{ gridColumn: '1 / -1', padding: '4rem', textAlign: 'center', background: 'var(--subtle-bg-2)', borderRadius: '12px', border: '1px dashed var(--border-color)' }}>
                <Megaphone size={48} color="var(--text-secondary)" style={{ opacity: 0.3, margin: '0 auto 1rem' }} />
                <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '0.5rem' }}>No campaigns found</h3>
                <p style={{ color: 'var(--text-secondary)' }}>Launch your first email campaign to start tracking engagement.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {showCreateCampaign && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(15, 23, 42, 0.9)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <form role="dialog" className="card modal" onSubmit={handleCreateCampaign} style={{ padding: '2.5rem', width: '500px', border: '1px solid var(--border-color)', boxShadow: '0 25px 50px rgba(0,0,0,0.8)' }}>
            <h3 style={{ fontSize: '1.25rem', fontWeight: 'bold', marginBottom: '1.5rem' }}>Create New Campaign</h3>
            <div style={{ marginBottom: '1.5rem' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Campaign Name</label>
              <input type="text" required autoFocus className="input-field" value={newCampaignName} onChange={e => setNewCampaignName(e.target.value)} placeholder="e.g. Q4 Product Launch" />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem' }}>
              <button type="button" onClick={() => setShowCreateCampaign(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>Cancel</button>
              <button type="submit" className="btn-primary">Create Campaign</button>
            </div>
          </form>
        </div>
      )}

      {(activeTab === 'sms' || activeTab === 'push') && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', padding: '4rem', background: 'var(--subtle-bg-2)', borderRadius: '12px', border: '1px dashed var(--border-color)', maxWidth: '500px' }}>
            <Megaphone size={48} color="var(--text-secondary)" style={{ opacity: 0.3, margin: '0 auto 1rem' }} />
            <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '0.5rem' }}>{activeTab === 'sms' ? 'SMS' : 'Push'} Campaigns</h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
              Configure your {activeTab === 'sms' ? 'SMS provider (MSG91 / Twilio)' : 'VAPID keys and push'} settings first, then create templates and send campaigns.
            </p>
            <a href="/channels" style={{ color: 'var(--accent-color)', fontWeight: '500', textDecoration: 'none' }}>Go to Channels Settings →</a>
          </div>
        </div>
      )}

      {activeTab === 'forms' && (
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
                <div key={field.id} style={{ display: 'flex', gap: '1rem', alignItems: 'center', background: 'var(--subtle-bg-2)', padding: '1rem', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                  <div style={{ width: '24px', height: '24px', borderRadius: '50%', background: 'var(--subtle-bg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem' }}>{idx + 1}</div>
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
      )}
    </div>
  );
}
