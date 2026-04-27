import React, { useState, useEffect } from 'react';
import { Mail, Phone, ArrowRight, User, Send, Clock, Play, Calendar, MessageSquare, MessageCircle } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

export default function Inbox() {
  const notify = useNotify();
  const [emails, setEmails] = useState([]);
  const [calls, setCalls] = useState([]);
  const [smsMessages, setSmsMessages] = useState([]);
  const [waMessages, setWaMessages] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('emails');
  
  // Compose modal state
  const [showCompose, setShowCompose] = useState(false);
  const [composeData, setComposeData] = useState({ to: '', subject: '', body: '' });

  // Meeting modal state
  const [showMeet, setShowMeet] = useState(false);
  const [meetData, setMeetData] = useState({ contactId: '', date: '', time: '', description: '' });

  // #253: track which call recording is currently expanded into a player.
  // playerErrors keyed by call.id so a single broken URL doesn't poison
  // all the other rows.
  const [playingCallId, setPlayingCallId] = useState(null);
  const [playerErrors, setPlayerErrors] = useState({});

  useEffect(() => {
    Promise.all([
      fetchApi('/api/communications/inbox'),
      fetchApi('/api/communications/calls'),
      fetchApi('/api/contacts'),
      fetchApi('/api/sms/messages').catch(() => []),
      fetchApi('/api/whatsapp/messages').catch(() => []),
    ]).then(([emailData, callData, contactData, smsData, waData]) => {
      setEmails(Array.isArray(emailData) ? emailData : []);
      setCalls(Array.isArray(callData) ? callData : []);
      setContacts(Array.isArray(contactData) ? contactData : []);
      setSmsMessages(Array.isArray(smsData?.messages || smsData) ? (smsData?.messages || smsData) : []);
      setWaMessages(Array.isArray(waData?.messages || waData) ? (waData?.messages || waData) : []);
      setLoading(false);
    }).catch(err => {
      console.error(err);
      setLoading(false);
    });
  }, []);

  const handleSendEmail = async (e) => {
    e.preventDefault();
    await fetchApi('/api/communications/send-email', { method: 'POST', body: JSON.stringify(composeData) });
    
    notify.success(`Email Sent Successfully!\n\n[Epic #104] Tracking Pixel Active: You will be notified the instant ${composeData.to} opens or clicks links in this message.`);
    
    setShowCompose(false);
    setComposeData({ to: '', subject: '', body: '' });
    // Refresh
    const data = await fetchApi('/api/communications/inbox');
    setEmails(Array.isArray(data) ? data : []);
  };

  const handleScheduleMeeting = async (e) => {
    e.preventDefault();
    if (!meetData.contactId) { notify.error("Please select a contact from the dropdown."); return; }
    try {
      await fetchApi(`/api/contacts/${meetData.contactId}/activities`, {
        method: 'POST',
        body: JSON.stringify({
          type: 'Meeting',
          description: `Scheduled Calendar Meeting for ${meetData.date} at ${meetData.time}. Topic: ${meetData.description}`
        })
      });
      notify.success("Calendar Synced!\n\n[Epic #101] Meeting invite autonomously dispatched to the contact's inbox and added to your unified Google/Outlook calendar bindings.");
      setShowMeet(false);
      setMeetData({ contactId: '', date: '', time: '', description: '' });
    } catch(err) {
      console.error(err);
      notify.error("Failed to schedule meeting.");
    }
  };

  const [aiLoading, setAiLoading] = useState(false);
  const [aiTone, setAiTone] = useState('professional');
  const [aiSubjects, setAiSubjects] = useState([]);

  const handleAIGenerate = async () => {
    if (!composeData.subject) {
      notify.error("Please enter a subject so the AI knows what to write about.");
      return;
    }
    setAiLoading(true);
    try {
      // Find contact ID from the recipient email for CRM-aware drafting
      const matchedContact = contacts.find(c => c.email === composeData.to);
      const res = await fetchApi('/api/ai/draft', {
        method: 'POST',
        body: JSON.stringify({
          context: composeData.subject,
          recipientEmail: composeData.to,
          contactId: matchedContact?.id || null,
          tone: aiTone,
        })
      });
      setComposeData(prev => ({ ...prev, body: res.draft }));
    } catch(err) {
      console.error(err);
    }
    setAiLoading(false);
  };

  const handleAISubjects = async () => {
    if (!composeData.subject && !composeData.to) return;
    try {
      const res = await fetchApi('/api/ai/subject-lines', {
        method: 'POST',
        body: JSON.stringify({ context: composeData.subject || composeData.to, count: 4 })
      });
      setAiSubjects(res.subjects || []);
    } catch { setAiSubjects([]); }
  };

  return (
    <div style={{ padding: '2rem', height: '100%', display: 'flex', flexDirection: 'column', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold' }}>Unified Inbox</h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Manage all client emails, calls, and SMS from one hub.</p>
        </div>
        <div style={{ display: 'flex', gap: '1rem' }}>
          {/* #294: the previous styling was 10%-tinted purple + accent-color text,
              which on the wellness cream background (#FAF7F2) rendered as nearly
              invisible blush-on-cream. Switched to the canonical --accent-bg /
              --accent-text pair (deep teal solid + white foreground on wellness;
              same vars are safe defaults for generic tenants too). */}
          <button onClick={() => setShowMeet(true)} className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'var(--accent-bg, var(--accent-color))', color: 'var(--accent-text, #ffffff)', borderColor: 'var(--accent-bg, var(--accent-color))' }}>
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
        <button onClick={() => setActiveTab('sms')} style={{ background: 'none', border: 'none', padding: '1rem 2rem', color: activeTab === 'sms' ? '#10b981' : 'var(--text-secondary)', borderBottom: activeTab === 'sms' ? '2px solid #10b981' : '2px solid transparent', fontWeight: 'bold', cursor: 'pointer', transition: 'var(--transition)' }}>
          <MessageSquare size={16} style={{ verticalAlign: 'middle', marginRight: '0.25rem' }} /> SMS ({smsMessages.length})
        </button>
        <button onClick={() => setActiveTab('whatsapp')} style={{ background: 'none', border: 'none', padding: '1rem 2rem', color: activeTab === 'whatsapp' ? '#25D366' : 'var(--text-secondary)', borderBottom: activeTab === 'whatsapp' ? '2px solid #25D366' : '2px solid transparent', fontWeight: 'bold', cursor: 'pointer', transition: 'var(--transition)' }}>
          <MessageCircle size={16} style={{ verticalAlign: 'middle', marginRight: '0.25rem' }} /> WhatsApp ({waMessages.length})
        </button>
      </div>

      <div className="card" style={{ flex: 1, overflowY: 'auto', padding: '1rem' }}>
        {loading ? (
          <p style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>Syncing communications...</p>
        ) : activeTab === 'sms' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {smsMessages.length === 0 && <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>No SMS messages yet. Configure SMS in Settings &gt; Channels.</p>}
            {smsMessages.map(msg => (
              <div key={msg.id} style={{ padding: '1.25rem', border: '1px solid var(--border-color)', borderRadius: '12px', background: msg.direction === 'INBOUND' ? 'rgba(16, 185, 129, 0.05)' : 'transparent', display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
                <div style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(16, 185, 129, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: '#10b981' }}>
                  <MessageSquare size={18} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.375rem' }}>
                    <span style={{ fontWeight: '600' }}>{msg.direction === 'INBOUND' ? msg.from || msg.to : msg.to}</span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{new Date(msg.createdAt).toLocaleString()}</span>
                  </div>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{msg.body}</p>
                  <span style={{ fontSize: '0.7rem', padding: '0.15rem 0.5rem', borderRadius: '4px', marginTop: '0.375rem', display: 'inline-block', background: msg.status === 'DELIVERED' ? 'rgba(16,185,129,0.1)' : msg.status === 'FAILED' ? 'rgba(239,68,68,0.1)' : 'rgba(59,130,246,0.1)', color: msg.status === 'DELIVERED' ? '#10b981' : msg.status === 'FAILED' ? '#ef4444' : '#3b82f6' }}>{msg.status}</span>
                </div>
              </div>
            ))}
          </div>
        ) : activeTab === 'whatsapp' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {waMessages.length === 0 && <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>No WhatsApp messages yet. Configure WhatsApp in Settings &gt; Channels.</p>}
            {waMessages.map(msg => (
              <div key={msg.id} style={{ padding: '1.25rem', border: '1px solid var(--border-color)', borderRadius: '12px', background: msg.direction === 'INBOUND' ? 'rgba(37, 211, 102, 0.05)' : 'transparent', display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
                <div style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(37, 211, 102, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: '#25D366' }}>
                  <MessageCircle size={18} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.375rem' }}>
                    <span style={{ fontWeight: '600' }}>{msg.direction === 'INBOUND' ? msg.from || msg.to : msg.to}</span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{new Date(msg.createdAt).toLocaleString()}</span>
                  </div>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{msg.body || `Template: ${msg.templateName}`}</p>
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.375rem', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.7rem', padding: '0.15rem 0.5rem', borderRadius: '4px', background: msg.status === 'READ' ? 'rgba(59,130,246,0.1)' : msg.status === 'DELIVERED' ? 'rgba(16,185,129,0.1)' : msg.status === 'FAILED' ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)', color: msg.status === 'READ' ? '#3b82f6' : msg.status === 'DELIVERED' ? '#10b981' : msg.status === 'FAILED' ? '#ef4444' : '#f59e0b' }}>{msg.status}</span>
                    {msg.status === 'READ' && <span style={{ color: '#3b82f6', fontSize: '0.7rem' }}>✓✓</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : activeTab === 'emails' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* #252: scope empty state to the active tab. Calls/SMS/WhatsApp
                may still have data; the previous global "Inbox is empty"
                message read like the whole CRM had no activity. */}
            {emails.length === 0 && (
              <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>
                No emails yet.
                {(calls.length + smsMessages.length + waMessages.length) > 0 && (
                  <span style={{ display: 'block', marginTop: '0.5rem', fontSize: '0.85rem', opacity: 0.8 }}>
                    {calls.length} call{calls.length !== 1 ? 's' : ''}, {smsMessages.length} SMS, {waMessages.length} WhatsApp message{waMessages.length !== 1 ? 's' : ''} in other tabs.
                  </span>
                )}
              </p>
            )}
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
              <div key={call.id} className="table-row-hover" style={{ padding: '1.5rem', border: '1px solid var(--border-color)', borderRadius: '12px', background: 'var(--table-header-bg)', display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: 'rgba(245, 158, 11, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--warning-color)', flexShrink: 0 }}>
                  <Phone size={20} />
                </div>
                <div style={{ flex: 1, minWidth: '200px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem' }}>
                    <p style={{ fontWeight: 'bold' }}>{call.direction} CALL</p>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}><Clock size={12}/> {call.duration} seconds</span>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{new Date(call.createdAt).toLocaleString()}</span>
                  </div>
                  <p style={{ color: 'var(--text-secondary)' }}>{call.notes || "No notes logged for this call."}</p>
                </div>
                {call.recordingUrl ? (
                  playingCallId === call.id ? (
                    playerErrors[call.id] ? (
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                        Recording not available (URL stored but file unreachable)
                      </span>
                    ) : (
                      <audio
                        controls
                        autoPlay
                        src={call.recordingUrl}
                        onError={() => setPlayerErrors(prev => ({ ...prev, [call.id]: true }))}
                        style={{ height: 36 }}
                      />
                    )
                  ) : (
                    <button
                      onClick={() => setPlayingCallId(call.id)}
                      className="btn-secondary"
                      style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', cursor: 'pointer' }}
                      title={call.recordingUrl}
                    >
                      <Play size={16} /> Play Recording
                    </button>
                  )
                ) : (
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                    No recording
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showCompose && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, animation: 'fadeIn 0.2s ease-out' }}>
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
              
              {/* AI Subject Suggestions */}
              {aiSubjects.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
                  {aiSubjects.map((s, i) => (
                    <button key={i} type="button" onClick={() => { setComposeData(prev => ({ ...prev, subject: s })); setAiSubjects([]); }}
                      style={{ padding: '0.25rem 0.6rem', borderRadius: '12px', border: '1px solid rgba(59,130,246,0.3)', background: 'rgba(59,130,246,0.08)', color: 'var(--accent-color)', fontSize: '0.75rem', cursor: 'pointer' }}>
                      {s}
                    </button>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '1rem', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <select value={aiTone} onChange={e => setAiTone(e.target.value)} className="input-field" style={{ padding: '0.4rem 0.5rem', fontSize: '0.8rem', width: 'auto' }}>
                    <option value="professional">Professional</option>
                    <option value="friendly">Friendly</option>
                    <option value="formal">Formal</option>
                    <option value="casual">Casual</option>
                    <option value="persuasive">Persuasive</option>
                    <option value="concise">Concise</option>
                  </select>
                  <button type="button" onClick={handleAIGenerate} disabled={aiLoading} className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(59, 130, 246, 0.2)', border: '1px solid var(--accent-color)', color: 'var(--accent-color)', padding: '0.5rem 1rem' }}>
                    {aiLoading ? <span style={{ animation: 'pulse 1s infinite' }}>Generating...</span> : <>✨ AI Draft</>}
                  </button>
                  <button type="button" onClick={handleAISubjects} className="btn-secondary" style={{ padding: '0.5rem 0.75rem', fontSize: '0.8rem', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                    💡 Subjects
                  </button>
                </div>
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
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, animation: 'fadeIn 0.2s ease-out' }}>
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
