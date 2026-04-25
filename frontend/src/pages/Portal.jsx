import React, { useState } from 'react';
import { ShieldAlert, Book, Ticket as TicketFIcon, Send, ChevronDown, ChevronUp } from 'lucide-react';
import { useNotify } from '../utils/notify';

const articles = [
  {
    title: 'Getting Started with Globussoft CRM',
    content: 'Welcome to Globussoft CRM! Here\'s how to get started:\n\n1. **Import your contacts** — Go to Contacts and click "Import CSV" to bulk-upload your existing contact database.\n\n2. **Set up your pipeline** — Navigate to Settings to customize your pipeline stages (New Lead, Contacted, Proposal, etc.).\n\n3. **Create your first deal** — Click "Add Deal" on the Pipeline page to start tracking your first opportunity.\n\n4. **Connect your email** — Go to the Inbox to set up email integration and start tracking conversations.\n\n5. **Explore Reports** — The Reports section gives you real-time analytics on revenue, deals, and team performance.'
  },
  {
    title: 'Managing Contacts, Leads & Clients',
    content: 'The CRM organizes your relationships into three categories:\n\n**Leads** — New potential customers who haven\'t been qualified yet. Use AI Lead Scoring to automatically prioritize high-value leads.\n\n**Prospects** — Qualified leads who are actively in your sales pipeline. Track their journey through pipeline stages.\n\n**Customers** — Closed deals who are now active clients. Use the Clients view to manage ongoing relationships.\n\nYou can convert a Lead to a Customer by clicking "Convert to Customer" on their record. All activities, emails, and deal history are preserved.'
  },
  {
    title: 'Pipeline & Deal Management',
    content: 'The Pipeline is your visual sales board:\n\n**Drag & Drop** — Move deals between stages by dragging cards. Changes sync in real-time across all users.\n\n**AI Scoring** — Click the Zap icon on any deal card to get AI-predicted win probability.\n\n**Custom Stages** — Go to Settings > Pipeline Stages to add, remove, or reorder your pipeline stages.\n\n**CPQ (Configure Price Quote)** — Click any deal to open the detail modal, then use the CPQ builder to create structured pricing quotes with line items.'
  },
  {
    title: 'Invoicing, Estimates & Expenses',
    content: 'The financial suite includes:\n\n**Invoices** — Create invoices linked to contacts and deals. Mark them as paid, export to PDF, or void them.\n\n**Estimates** — Build detailed estimates with line items. When accepted, convert them directly to invoices with one click.\n\n**Expenses** — Track team expenses by category (Travel, Software, Office, etc.). Managers can approve, reject, or mark expenses as reimbursed.\n\n**Contracts** — Manage contract lifecycles from Draft through Active to Expired or Terminated.'
  },
  {
    title: 'Automation: Sequences & Workflows',
    content: 'Automate repetitive tasks:\n\n**Sequences** — Build multi-step drip campaigns using the visual flow editor. Chain emails, wait periods, and tasks together. Enroll contacts to run sequences automatically.\n\n**Workflows** — Set up trigger-based automation rules. For example: "When a deal stage changes to Won, send a welcome email and create an onboarding task."\n\n**Lead Scoring** — The AI engine scores contacts every 10 minutes based on engagement, deal size, and activity patterns.'
  },
  {
    title: 'Using the Developer Portal',
    content: 'For integrations and API access:\n\n**API Keys** — Generate API keys from the Developer page. Use them to authenticate external applications.\n\n**Webhooks** — Register webhook URLs to receive real-time notifications when events occur (deal created, contact updated, etc.).\n\n**API Documentation** — Full interactive docs are available at /api-docs (Swagger UI).\n\n**Rate Limits** — Standard accounts get 5,000 requests per 15 minutes. Contact support for enterprise limits.'
  },
];

function renderBoldText(text) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

export default function Portal() {
  const notify = useNotify();
  const [form, setForm] = useState({ subject: '', description: '', priority: 'Medium' });
  const [submitted, setSubmitted] = useState(false);
  const [expandedArticle, setExpandedArticle] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await fetch('/api/tickets/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      setSubmitted(true);
      setForm({ subject: '', description: '', priority: 'Medium' });
    } catch(err) {
      notify.error("Portal failure communicating with Core API.");
    }
  };

  const toggleArticle = (index) => {
    setExpandedArticle(expandedArticle === index ? null : index);
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-color)', color: 'var(--text-primary)', padding: '4rem 2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', animation: 'fadeIn 0.5s ease-out' }}>

      <div style={{ textAlign: 'center', marginBottom: '4rem' }}>
        <h1 style={{ fontSize: '3rem', fontWeight: 'bold', background: 'linear-gradient(135deg, #3b82f6, #ec4899)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', marginBottom: '1rem' }}>Support & Knowledge Base</h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '1.25rem', maxWidth: '600px', margin: '0 auto' }}>Publicly accessible ingress point for raising enterprise IT tickets and reading architectural documentation.</p>
      </div>

      <div style={{ display: 'flex', gap: '3rem', maxWidth: '1000px', width: '100%', flexWrap: 'wrap' }}>

        {/* Knowledge Base */}
        <div className="card" style={{ flex: 1, minWidth: '350px', padding: '2rem', background: 'var(--subtle-bg-2)', border: '1px solid var(--border-color)' }}>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Book color="#3b82f6" /> Help Articles
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {articles.map((art, i) => (
              <div key={i} style={{ borderRadius: '8px', overflow: 'hidden' }}>
                <div
                  style={{ padding: '1rem', background: 'var(--subtle-bg)', borderRadius: expandedArticle === i ? '8px 8px 0 0' : '8px', cursor: 'pointer', transition: 'background 0.2s', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                  onClick={() => toggleArticle(i)}
                  onMouseOver={e=>e.currentTarget.style.background='rgba(59, 130, 246, 0.1)'}
                  onMouseOut={e=>e.currentTarget.style.background='var(--subtle-bg)'}
                >
                  <div>
                    <h4 style={{ fontWeight: '500', color: 'var(--text-primary)' }}>{art.title}</h4>
                    {expandedArticle !== i && (
                      <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Read knowledge base article &rarr;</p>
                    )}
                  </div>
                  {expandedArticle === i ? <ChevronUp size={18} color="var(--text-secondary)" /> : <ChevronDown size={18} color="var(--text-secondary)" />}
                </div>
                {expandedArticle === i && (
                  <div style={{ padding: '1rem 1.25rem', background: 'var(--subtle-bg-2)', borderTop: '1px solid var(--border-color)', borderRadius: '0 0 8px 8px', lineHeight: '1.7', fontSize: '0.925rem', color: 'var(--text-secondary)', whiteSpace: 'pre-line' }}>
                    {renderBoldText(art.content)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Ticketing */}
        <div className="card" style={{ flex: 1, minWidth: '350px', padding: '2rem', background: 'var(--subtle-bg-2)', border: '1px solid var(--border-color)' }}>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <TicketFIcon color="#ec4899" /> Raise IT Ticket
          </h2>

          {submitted ? (
            <div style={{ textAlign: 'center', padding: '4rem 1rem', animation: 'pulse 1s ease-out' }}>
              <ShieldAlert size={56} color="#10b981" style={{ margin: '0 auto 1.5rem' }} />
              <h3 style={{ fontSize: '1.5rem', fontWeight: '600', color: '#10b981' }}>Ticket Received Securely</h3>
              <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>A support agent will evaluate its trajectory shortly.</p>
              <button onClick={() => setSubmitted(false)} className="btn-secondary" style={{ marginTop: '2.5rem', padding: '0.75rem 1.5rem' }}>Submit Another Bug</button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Issue Subject</label>
                <input type="text" required className="input-field" value={form.subject} onChange={e=>setForm({...form, subject: e.target.value})} style={{ background: 'var(--input-bg)', borderColor: 'var(--border-color)' }} placeholder="Brief description of your issue..." />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Severity & Priority Level</label>
                <select className="input-field" value={form.priority} onChange={e=>setForm({...form, priority: e.target.value})} style={{ background: 'var(--input-bg)', borderColor: 'var(--border-color)' }}>
                  <option style={{background:'var(--input-bg)'}}>Low</option>
                  <option style={{background:'var(--input-bg)'}}>Medium</option>
                  <option style={{background:'var(--input-bg)'}}>High</option>
                  <option style={{background:'var(--input-bg)'}}>Urgent (Showstopper)</option>
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Detailed Diagnostic Stack</label>
                <textarea required rows={5} className="input-field" value={form.description} onChange={e=>setForm({...form, description: e.target.value})} style={{ background: 'var(--input-bg)', borderColor: 'var(--border-color)', resize: 'vertical' }} placeholder="Please explain the technical steps spanning the issue..." />
              </div>
              <button type="submit" className="btn-primary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', background: '#ec4899', marginTop: '0.5rem' }}>
                <Send size={18} /> Lodge Support Case Payload
              </button>
            </form>
          )}

        </div>
      </div>
    </div>
  );
}
