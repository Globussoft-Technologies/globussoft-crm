import React, { useState } from 'react';
import { ShieldAlert, Book, Ticket as TicketFIcon, Send } from 'lucide-react';

export default function Portal() {
  const [form, setForm] = useState({ subject: '', description: '', priority: 'Medium' });
  const [submitted, setSubmitted] = useState(false);

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
      alert("Portal failure communicating with Core API.");
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: '#020617', color: '#f8fafc', padding: '4rem 2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', animation: 'fadeIn 0.5s ease-out' }}>
      
      <div style={{ textAlign: 'center', marginBottom: '4rem' }}>
        <h1 style={{ fontSize: '3rem', fontWeight: 'bold', background: 'linear-gradient(135deg, #3b82f6, #ec4899)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', marginBottom: '1rem' }}>Support & Knowledge Base</h1>
        <p style={{ color: '#94a3b8', fontSize: '1.25rem', maxWidth: '600px', margin: '0 auto' }}>Publicly accessible ingress point for raising enterprise IT tickets and reading architectural documentation.</p>
      </div>

      <div style={{ display: 'flex', gap: '3rem', maxWidth: '1000px', width: '100%', flexWrap: 'wrap' }}>
        
        {/* Knowledge Base */}
        <div className="card" style={{ flex: 1, minWidth: '350px', padding: '2rem', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.1)' }}>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Book color="#3b82f6" /> Help Articles
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {['Getting Started with Globussoft CRM', 'Configuring IMAP/SMTP Inboxes', 'Understanding Predictive AI Lead Scoring', 'Exporting PDF Cryptographic Invoices'].map((art, i) => (
              <div key={i} style={{ padding: '1rem', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', cursor: 'pointer', transition: 'background 0.2s' }} onMouseOver={e=>e.currentTarget.style.background='rgba(59, 130, 246, 0.1)'} onMouseOut={e=>e.currentTarget.style.background='rgba(255,255,255,0.05)'}>
                <h4 style={{ fontWeight: '500', color: '#e2e8f0' }}>{art}</h4>
                <p style={{ fontSize: '0.875rem', color: '#64748b', marginTop: '0.25rem' }}>Read knowledge base article &rarr;</p>
              </div>
            ))}
          </div>
        </div>

        {/* Ticketing */}
        <div className="card" style={{ flex: 1, minWidth: '350px', padding: '2rem', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.1)' }}>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <TicketFIcon color="#ec4899" /> Raise IT Ticket
          </h2>
          
          {submitted ? (
            <div style={{ textAlign: 'center', padding: '4rem 1rem', animation: 'pulse 1s ease-out' }}>
              <ShieldAlert size={56} color="#10b981" style={{ margin: '0 auto 1.5rem' }} />
              <h3 style={{ fontSize: '1.5rem', fontWeight: '600', color: '#10b981' }}>Ticket Received Securely</h3>
              <p style={{ color: '#94a3b8', marginTop: '0.5rem' }}>A support agent will evaluate its trajectory shortly.</p>
              <button onClick={() => setSubmitted(false)} className="btn-secondary" style={{ marginTop: '2.5rem', padding: '0.75rem 1.5rem' }}>Submit Another Bug</button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem' }}>Issue Subject</label>
                <input type="text" required className="input-field" value={form.subject} onChange={e=>setForm({...form, subject: e.target.value})} style={{ background: '#0f172a', borderColor: 'rgba(255,255,255,0.1)' }} placeholder="Brief description of your issue..." />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem' }}>Severity & Priority Level</label>
                <select className="input-field" value={form.priority} onChange={e=>setForm({...form, priority: e.target.value})} style={{ background: '#0f172a', borderColor: 'rgba(255,255,255,0.1)' }}>
                  <option style={{background:'#0f172a'}}>Low</option>
                  <option style={{background:'#0f172a'}}>Medium</option>
                  <option style={{background:'#0f172a'}}>High</option>
                  <option style={{background:'#0f172a'}}>Urgent (Showstopper)</option>
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem' }}>Detailed Diagnostic Stack</label>
                <textarea required rows={5} className="input-field" value={form.description} onChange={e=>setForm({...form, description: e.target.value})} style={{ background: '#0f172a', borderColor: 'rgba(255,255,255,0.1)', resize: 'vertical' }} placeholder="Please explain the technical steps spanning the issue..." />
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
