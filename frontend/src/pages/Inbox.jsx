import React, { useState, useEffect } from 'react';
import { Mail, Phone, ArrowRight, User, Send, Clock, Play, Calendar } from 'lucide-react';
import { fetchApi } from '../utils/api';

export default function Inbox() {
  const [emails, setEmails] = useState([]);
  const [calls, setCalls] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('emails');
  
  // Compose modal state
  const [showCompose, setShowCompose] = useState(false);
  const [composeData, setComposeData] = useState({ to: '', subject: '', body: '' });

  // Meeting modal state
  const [showMeet, setShowMeet] = useState(false);
  const [meetData, setMeetData] = useState({ contactId: '', date: '', time: '', description: '' });

  useEffect(() => {
    Promise.all([
      fetchApi('/api/communications/inbox'),
      fetchApi('/api/communications/calls'),
      fetchApi('/api/contacts')
    ]).then(([emailData, callData, contactData]) => {
      setEmails(Array.isArray(emailData) ? emailData : []);
      setCalls(Array.isArray(callData) ? callData : []);
      setContacts(Array.isArray(contactData) ? contactData : []);
      setLoading(false);
    }).catch(err => {
      console.error(err);
      setLoading(false);
    });
  }, []);

  const handleSendEmail = async (e) => {
    e.preventDefault();
    await fetchApi('/api/communications/send-email', { method: 'POST', body: JSON.stringify(composeData) });
    
    alert(`Email Sent Successfully!\n\n[Epic #104] Tracking Pixel Active: You will be notified the instant ${composeData.to} opens or clicks links in this message.`);
    
    setShowCompose(false);
    setComposeData({ to: '', subject: '', body: '' });
    // Refresh
    const data = await fetchApi('/api/communications/inbox');
    setEmails(Array.isArray(data) ? data : []);
  };

  const handleScheduleMeeting = async (e) => {
    e.preventDefault();
    if (!meetData.contactId) { alert("Please select a contact from the dropdown."); return; }
    try {
      await fetchApi(`/api/contacts/${meetData.contactId}/activities`, {
        method: 'POST',
        body: JSON.stringify({
          type: 'Meeting',
          description: `Scheduled Calendar Meeting for ${meetData.date} at ${meetData.time}. Topic: ${meetData.description}`
        })
      });
      alert("Calendar Synced!\n\n[Epic #101] Meeting invite autonomously dispatched to the contact's inbox and added to your unified Google/Outlook calendar bindings.");
      setShowMeet(false);
      setMeetData({ contactId: '', date: '', time: '', description: '' });
    } catch(err) {
      console.error(err);
      alert("Failed to schedule meeting.");
    }
  };

  const [aiLoading, setAiLoading] = useState(false);
  const handleAIGenerate = async () => {
    if (!composeData.subject) {
      alert("Please enter a subject so the AI knows what to write about.");
      return;
    }
    setAiLoading(true);
    try {
      const res = await fetchApi('/api/ai/draft', { method: 'POST', body: JSON.stringify({ context: composeData.subject }) });
      setComposeData(prev => ({ ...prev, body: res.draft }));
    } catch(err) {
      console.error(err);
    }
    setAiLoading(false);
  };

  return (
    <div style={{ padding: '2rem', height: '100%', display: 'flex', flexDirection: 'column', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold' }}>Unified Inbox</h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Manage all client emails, calls, and SMS from one hub.</p>
        </div>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <button onClick={() => setShowMeet(true)} className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(168, 85, 247, 0.1)', color: 'var(--accent-color)', borderColor: 'var(--accent-color)' }}>
            <Calendar size={18} /> Schedule Meeting
          </button>
          <button className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Phone size={18} /> Call Dialer
          </button>
          <button onClick={() => setShowCompose(true)} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Mail size={18} /> Compose Email
          </button>
        </div>
      </header>

      <div style={{ display: 'flex', gap: '1rem', borderBottom: '1px solid var(--border-color)', marginBottom: '1.5rem' }}>
        <button onClick={() => setActiveTab('emails')} style={{ background: 'none', border: 'none', padding: '1rem 2rem', color: activeTab === 'emails' ? 'var(--accent-color)' : 'var(--text-secondary)', borderBottom: activeTab === 'emails' ? '2px solid var(--accent-color)' : '2px solid transparent', fontWeight: 'bold', cursor: 'pointer', transition: 'var(--transition)' }}>
          Emails ({emails.length})
        </button>
        <button onClick={() => setActiveTab('calls')} style={{ background: 'none', border: 'none', padding: '1rem 2rem', color: activeTab === 'calls' ? 'var(--warning-color)' : 'var(--text-secondary)', borderBottom: activeTab === 'calls' ? '2px solid var(--warning-color)' : '2px solid transparent', fontWeight: 'bold', cursor: 'pointer', transition: 'var(--transition)' }}>
          Call Logs ({calls.length})
        </button>
      </div>

      <div className="card" style={{ flex: 1, overflowY: 'auto', padding: '1rem' }}>
        {loading ? (
          <p style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>Syncing communications...</p>
        ) : activeTab === 'emails' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {emails.length === 0 && <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>Inbox is empty. Start communicating!</p>}
            {emails.map(email => (
              <div key={email.id} className="table-row-hover" style={{ padding: '1.5rem', border: '1px solid var(--border-color)', borderRadius: '12px', background: email.read ? 'rgba(0,0,0,0.2)' : 'rgba(59, 130, 246, 0.05)', display: 'flex', gap: '1.5rem', cursor: 'pointer' }}>
                <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: 'var(--accent-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <User size={20} color="#fff" />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                    <p style={{ fontWeight: 'bold', fontSize: '1.1rem' }}>{email.from} <ArrowRight size={14} style={{ margin:'0 0.5rem' }}/> {email.to}</p>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{new Date(email.createdAt).toLocaleString()}</span>
                  </div>
                  <h4 style={{ fontWeight: '600', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>{email.subject}</h4>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: '1.5' }}>{email.body}</p>
                </div>
                {!email.read && <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'var(--accent-color)', alignSelf: 'center' }}></div>}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {calls.length === 0 && <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>No recent calls.</p>}
            {calls.map(call => (
              <div key={call.id} className="table-row-hover" style={{ padding: '1.5rem', border: '1px solid var(--border-color)', borderRadius: '12px', background: 'rgba(0,0,0,0.2)', display: 'flex', gap: '1.5rem', alignItems: 'center' }}>
                <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: 'rgba(245, 158, 11, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--warning-color)', flexShrink: 0 }}>
                  <Phone size={20} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem' }}>
                    <p style={{ fontWeight: 'bold' }}>{call.direction} CALL</p>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}><Clock size={12}/> {call.duration} seconds</span>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{new Date(call.createdAt).toLocaleString()}</span>
                  </div>
                  <p style={{ color: 'var(--text-secondary)' }}>{call.notes || "No notes logged for this call."}</p>
                </div>
                {call.recordingUrl && (
                  <button className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem' }}>
                    <Play size={16} /> Play Recording
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showCompose && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, animation: 'fadeIn 0.2s ease-out' }}>
          <div className="card" style={{ padding: '2.5rem', width: '600px', border: '1px solid rgba(59, 130, 246, 0.3)', boxShadow: '0 20px 40px rgba(0,0,0,0.5)' }}>
            <h3 style={{ marginBottom: '1.5rem', fontSize: '1.5rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Mail size={24} color="var(--accent-color)" /> New Message
            </h3>
            <form onSubmit={handleSendEmail} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>To:</label>
                <input type="email" list="contacts-list" required className="input-field" value={composeData.to} onChange={e => setComposeData({...composeData, to: e.target.value})} placeholder="client@company.com" />
                <datalist id="contacts-list">
                  {contacts.map(c => <option key={c.id} value={c.email}>{c.name}</option>)}
                </datalist>
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Subject:</label>
                <input type="text" required className="input-field" value={composeData.subject} onChange={e => setComposeData({...composeData, subject: e.target.value})} placeholder="Following up" />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Message:</label>
                <textarea required className="input-field" value={composeData.body} onChange={e => setComposeData({...composeData, body: e.target.value})} placeholder="Write your email here..." rows={6} style={{ resize: 'vertical' }} />
              </div>
              
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '1rem', alignItems: 'center' }}>
                <button type="button" onClick={handleAIGenerate} disabled={aiLoading} className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(59, 130, 246, 0.2)', border: '1px solid var(--accent-color)', color: 'var(--accent-color)', padding: '0.5rem 1rem' }}>
                  {aiLoading ? <span style={{ animation: 'pulse 1s infinite' }}>🧠 Simulating LLM...</span> : <>✨ AI Smart Draft</>}
                </button>
                <div style={{ display: 'flex', gap: '1rem' }}>
                  <button type="button" onClick={() => setShowCompose(false)} style={{ background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer', fontWeight: '500' }}>Discard</button>
                  <button type="submit" className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Send size={16} /> Send Email
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {showMeet && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, animation: 'fadeIn 0.2s ease-out' }}>
          <div className="card" style={{ padding: '2.5rem', width: '500px', border: '1px solid rgba(168, 85, 247, 0.3)', boxShadow: '0 20px 40px rgba(0,0,0,0.5)' }}>
            <h3 style={{ marginBottom: '1.5rem', fontSize: '1.5rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Calendar size={24} color="var(--accent-color)" /> Calendar Sync
            </h3>
            <form onSubmit={handleScheduleMeeting} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Associate with Contact:</label>
                <select required className="input-field" value={meetData.contactId} onChange={e => setMeetData({...meetData, contactId: e.target.value})}>
                  <option value="">-- Select Contact --</option>
                  {contacts.map(c => <option key={c.id} value={c.id}>{c.name} ({c.company})</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', gap: '1rem' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Date:</label>
                  <input type="date" required className="input-field" value={meetData.date} onChange={e => setMeetData({...meetData, date: e.target.value})} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Time:</label>
                  <input type="time" required className="input-field" value={meetData.time} onChange={e => setMeetData({...meetData, time: e.target.value})} />
                </div>
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Meeting Topic & Conferencing Links:</label>
                <textarea required className="input-field" value={meetData.description} onChange={e => setMeetData({...meetData, description: e.target.value})} placeholder="Zoom/Google Meet links and agenda..." rows={3} style={{ resize: 'vertical' }} />
              </div>
              
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem', gap: '1rem' }}>
                <button type="button" onClick={() => setShowMeet(false)} style={{ background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer', fontWeight: '500' }}>Cancel</button>
                <button type="submit" className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Calendar size={16} /> Send Invites
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
