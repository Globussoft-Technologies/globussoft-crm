import React, { useState, useEffect, useRef } from 'react';
import { Mail, Phone, ArrowRight, User, Send, Clock, Play, Calendar, MessageSquare, MessageCircle, X, PhoneCall, Paperclip, Sparkles, Lightbulb } from 'lucide-react';
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
  // #623 — cc / bcc default empty + collapsed; toggle reveals the inputs.
  // Mirrors Gmail / Outlook behaviour where Cc/Bcc are an opt-in surface
  // rather than always-visible chrome.
  const [composeData, setComposeData] = useState({ to: '', cc: '', bcc: '', subject: '', body: '' });
  const [showCcBcc, setShowCcBcc] = useState(false);
  // Custom themed autocomplete for the To: field. The native <datalist> dropdown
  // can't be styled (renders browser-default white in dark mode) and escaped
  // the modal's stacking context, hanging off the right edge of the viewport.
  const [showToDropdown, setShowToDropdown] = useState(false);
  // Compose attachments: File objects collected from the paperclip picker.
  // Posted as multipart "attachments[]" when present; the backend caps at
  // 5 files / 10 MB each (see communications.js composeAttachmentUpload).
  const [composeAttachments, setComposeAttachments] = useState([]);
  const composeFileInputRef = useRef(null);
  const MAX_ATTACHMENTS = 5;
  const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

  // #624 — Sent folder UI: a sub-tab on the Emails tab toggles the
  // backend folder filter (?folder=sent | ?folder=inbox | omitted=all).
  const [emailFolder, setEmailFolder] = useState('all'); // 'all' | 'inbox' | 'sent'

  // SMS Compose modal state
  const [showComposeSms, setShowComposeSms] = useState(false);
  const [composeSmsData, setComposeSmsData] = useState({ to: '', body: '' });

  // #594 — WhatsApp Compose modal state. Mirrors the SMS composer (phone +
  // body) but POSTs to /api/whatsapp/send. Pre-fix the WhatsApp tab could
  // only render inbound threads — there was no affordance to start a new
  // conversation.
  const [showComposeWa, setShowComposeWa] = useState(false);
  const [composeWaData, setComposeWaData] = useState({ to: '', body: '' });
  const [waSending, setWaSending] = useState(false);

  // Meeting modal state
  const [showMeet, setShowMeet] = useState(false);
  const [meetData, setMeetData] = useState({ contactId: '', date: '', time: '', description: '' });

  // #459: dialer modal — opened by the header "Call Dialer" button.
  // Mirrors the click-to-call helper in components/Softphone.jsx but kept
  // local here so the inbox stays self-contained and doesn't require the
  // global softphone bar to be mounted.
  const [showDialer, setShowDialer] = useState(false);
  const [dialerData, setDialerData] = useState({ contactId: '', toNumber: '', notes: '' });
  const [dialing, setDialing] = useState(false);

  // #460: row-detail modal. Single slot keyed by ({ kind, item }) so the
  // same component renders email / call / sms / whatsapp details with a
  // shared close-on-backdrop / close-on-X behaviour.
  const [detail, setDetail] = useState(null); // { kind: 'email'|'call'|'sms'|'wa', item }

  // Call dialer modal state
  const [showCallDial, setShowCallDial] = useState(false);
  const [callDialData, setCallDialData] = useState({ contactId: '', notes: '' });

  // Email detail view state (PR #511 — separate modal pattern; coexists with
  // the shared `detail` modal for sms/wa/call. Blocker #7 in the review;
  // intentional carry-over for v3.4.13 cleanup.)
  // PR #511 #7: was a second modal pattern competing with `detail` for the
  // email tab specifically. Consolidated into the unified `detail` modal
  // above (the email branch now ports the avatar + bigger-subject layout
  // from the old selectedEmail modal). Email rows now setDetail({kind:'email',
  // item}) like every other channel.

  // #253: track which call recording is currently expanded into a player.
  // playerErrors keyed by call.id so a single broken URL doesn't poison
  // all the other rows.
  const [playingCallId, setPlayingCallId] = useState(null);
  const [playerErrors, setPlayerErrors] = useState({});

  // #624 — re-fetch emails when the folder sub-tab changes so the Sent
  // folder query lands the OUTBOUND-only set, the Inbox the INBOUND-only
  // set, and All keeps the original combined behaviour.
  const inboxPath = emailFolder === 'all'
    ? '/api/communications/inbox'
    : `/api/communications/inbox?folder=${emailFolder}`;

  useEffect(() => {
    Promise.all([
      fetchApi(inboxPath),
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
  }, [inboxPath]);

  const handleSendEmail = async (e) => {
    e.preventDefault();

    // Switch to multipart when attachments are present so the file buffers
    // round-trip cleanly. fetchApi detects FormData and drops the JSON
    // Content-Type so the browser can set the multipart boundary itself.
    let requestBody;
    if (composeAttachments.length > 0) {
      const fd = new FormData();
      fd.append('to', composeData.to);
      if (composeData.cc) fd.append('cc', composeData.cc);
      if (composeData.bcc) fd.append('bcc', composeData.bcc);
      fd.append('subject', composeData.subject);
      fd.append('body', composeData.body);
      for (const file of composeAttachments) fd.append('attachments', file, file.name);
      requestBody = fd;
    } else {
      requestBody = JSON.stringify(composeData);
    }
    await fetchApi('/api/communications/send-email', { method: 'POST', body: requestBody });

    notify.success(`Email Sent Successfully!\n\n[Epic #104] Tracking Pixel Active: You will be notified the instant ${composeData.to} opens or clicks links in this message.`);

    closeCompose();
    // Refresh
    const data = await fetchApi(inboxPath);
    setEmails(Array.isArray(data) ? data : []);
  };

  const handlePickAttachments = (e) => {
    const incoming = Array.from(e.target.files || []);
    if (incoming.length === 0) return;

    const accepted = [];
    const rejected = [];
    let nextCount = composeAttachments.length;
    for (const f of incoming) {
      if (nextCount >= MAX_ATTACHMENTS) {
        rejected.push(`${f.name} (max ${MAX_ATTACHMENTS} files)`);
        continue;
      }
      if (f.size > MAX_ATTACHMENT_BYTES) {
        rejected.push(`${f.name} (over 10 MB)`);
        continue;
      }
      accepted.push(f);
      nextCount += 1;
    }
    if (accepted.length > 0) setComposeAttachments(prev => [...prev, ...accepted]);
    if (rejected.length > 0) notify.error(`Some files were skipped:\n${rejected.join('\n')}`);
    // Reset the input value so picking the same file again still fires onChange.
    e.target.value = '';
  };

  const handleRemoveAttachment = (idx) => {
    setComposeAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  // To: field is comma-separated for multi-recipient. The dropdown filters on
  // (and replaces) only the LAST comma-separated token so the user can pick
  // recipients one at a time without nuking what they've already typed.
  const composeToTokens = composeData.to.split(',');
  const composeToFilter = (composeToTokens[composeToTokens.length - 1] || '').trim().toLowerCase();
  const filteredToContacts = contacts
    .filter(c => c.email)
    .filter(c => {
      if (!composeToFilter) return true;
      const email = (c.email || '').toLowerCase();
      const name = (c.name || '').toLowerCase();
      return email.includes(composeToFilter) || name.includes(composeToFilter);
    })
    .slice(0, 50);

  const handleSelectToContact = (email) => {
    setComposeData(prev => {
      const parts = prev.to.split(',').map(s => s.trim()).filter(Boolean);
      // Replace the last (in-progress) token with the picked email if the user
      // was mid-typing; otherwise append.
      if (parts.length === 0 || !prev.to.endsWith(',')) {
        if (parts.length > 0) parts[parts.length - 1] = email;
        else parts.push(email);
      } else {
        parts.push(email);
      }
      return { ...prev, to: parts.join(', ') };
    });
    setShowToDropdown(false);
  };

  // Single close path for the composer — header X, backdrop click, post-send.
  // Keeps the state-reset list in one place so we can't drift between callers.
  const closeCompose = () => {
    setShowCompose(false);
    setShowCcBcc(false);
    setComposeData({ to: '', cc: '', bcc: '', subject: '', body: '' });
    setComposeAttachments([]);
    setAiSubjects([]);
    setShowToDropdown(false);
  };

  const formatAttachmentSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleSendSms = async (e) => {
    e.preventDefault();
    try {
      await fetchApi('/api/sms/send', { method: 'POST', body: JSON.stringify(composeSmsData) });

      notify.success(`SMS Sent Successfully!\n\nYour message has been queued and will be delivered to ${composeSmsData.to}.`);

      setShowComposeSms(false);
      setComposeSmsData({ to: '', body: '' });
      // Refresh SMS messages
      const data = await fetchApi('/api/sms/messages').catch(() => ({}));
      setSmsMessages(Array.isArray(data?.messages || data) ? (data?.messages || data) : []);
    } catch (err) {
      notify.error('Failed to send SMS. Please check the phone number and try again.');
      console.error(err);
    }
  };

  // #594 — Send a new WhatsApp message via /api/whatsapp/send. The route
  // requires { to, body } at minimum (templateName is optional for richer
  // template flows; for the in-thread quick-compose we use plain text).
  const handleSendWa = async (e) => {
    e.preventDefault();
    const to = composeWaData.to.trim();
    const body = composeWaData.body.trim();
    if (!to || !body) {
      notify.error('Phone number and message body are required');
      return;
    }
    setWaSending(true);
    try {
      await fetchApi('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, body }),
      });
      notify.success(`WhatsApp message queued for ${to}.`);
      setShowComposeWa(false);
      setComposeWaData({ to: '', body: '' });
      const data = await fetchApi('/api/whatsapp/messages').catch(() => ({}));
      setWaMessages(Array.isArray(data?.messages || data) ? (data?.messages || data) : []);
    } catch (err) {
      const msg = err?.message || 'Unable to send WhatsApp message';
      if (/no active whatsapp/i.test(msg)) {
        notify.error('No active WhatsApp provider configured. Open Settings > Channels to add credentials.');
      } else {
        notify.error(`WhatsApp send failed: ${msg}`);
      }
    } finally {
      setWaSending(false);
    }
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

  const handleInitiateCall = async (e) => {
    e.preventDefault();
    if (!callDialData.contactId) { notify.error("Please select a contact from the dropdown."); return; }
    try {
      const contact = contacts.find(c => c.id === callDialData.contactId);
      await fetchApi('/api/communications/calls', {
        method: 'POST',
        body: JSON.stringify({
          contactId: callDialData.contactId,
          direction: 'OUTBOUND',
          notes: callDialData.notes
        })
      });
      notify.success(`Call initiated with ${contact?.name || 'contact'}. Connecting...`);
      setShowCallDial(false);
      setCallDialData({ contactId: '', notes: '' });
    } catch(err) {
      console.error(err);
      notify.error("Failed to initiate call.");
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

  // #459: Dial via the existing /api/telephony/click-to-call endpoint
  // (used by the Softphone bar). When `contactId` is selected we pre-fill
  // its phone, but allow the user to type a one-off number too. On 400
  // (no telephony provider configured) surface the actionable error
  // toast pointing at Settings > Channels rather than a generic "failed".
  const handleDial = async (e) => {
    e.preventDefault();
    if (!dialerData.toNumber.trim()) {
      notify.error('Enter a phone number to dial.');
      return;
    }
    setDialing(true);
    try {
      const res = await fetchApi('/api/telephony/click-to-call', {
        method: 'POST',
        body: JSON.stringify({
          to: dialerData.toNumber.trim(),
          contactId: dialerData.contactId || undefined,
        }),
      });
      // Optionally log a follow-up activity if the user typed notes + picked a contact.
      if (dialerData.contactId && dialerData.notes.trim()) {
        try {
          await fetchApi(`/api/contacts/${dialerData.contactId}/activities`, {
            method: 'POST',
            body: JSON.stringify({ type: 'Call', description: dialerData.notes.trim() }),
          });
        } catch { /* non-fatal — call already placed */ }
      }
      notify.success(`Dialing ${dialerData.toNumber}... (call id: ${res.callId || res.callLogId || 'queued'})`);
      setShowDialer(false);
      setDialerData({ contactId: '', toNumber: '', notes: '' });
      // Refresh the call-log tab so the new INITIATED entry appears
      try {
        const fresh = await fetchApi('/api/communications/calls');
        setCalls(Array.isArray(fresh) ? fresh : []);
      } catch { /* ignore */ }
    } catch (err) {
      const msg = err?.message || 'Unable to start call';
      // Most common gotcha: no telephony provider configured. Make the toast actionable.
      if (/telephony provider/i.test(msg)) {
        notify.error('No telephony provider configured. Open Settings > Channels to add MyOperator or Knowlarity credentials.');
      } else {
        notify.error(`Dial failed: ${msg}`);
      }
    } finally {
      setDialing(false);
    }
  };

  // #459: when a contact is selected from the dropdown, pre-fill their
  // phone if known so the user doesn't have to retype it.
  const onPickDialerContact = (contactId) => {
    const c = contacts.find((x) => String(x.id) === String(contactId));
    setDialerData((prev) => ({
      ...prev,
      contactId,
      toNumber: c?.phone || prev.toNumber,
    }));
  };

  return (
    <div style={{ padding: '2rem', height: '100%', display: 'flex', flexDirection: 'column', animation: 'fadeIn 0.5s ease-out' }}>
      {/* #485: flex-wrap + gap so the action group cleanly wraps below the title at
          narrow viewports instead of overlapping it. Inner action group also wraps
          so individual buttons stack on very tight widths rather than overflowing. */}
      <header style={{ marginBottom: '2.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div style={{ minWidth: 0, flex: '1 1 240px' }}>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold' }}>Unified Inbox</h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Manage all client emails, calls, and SMS from one hub.</p>
        </div>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <button onClick={() => setShowMeet(true)} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Calendar size={18} /> Schedule Meeting
          </button>
          <button onClick={() => setShowCallDial(true)} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Phone size={18} /> Call Dialer
          </button>
          <button onClick={() => setShowComposeSms(true)} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <MessageSquare size={18} /> Compose SMS
          </button>
          {/* #594 — Compose WhatsApp affordance. Pre-fix the WhatsApp tab
              had no way to start a new outbound thread.
              #726 — was visually inconsistent with the other compose
              buttons (outlined green pill among 4 solid teal pills).
              WhatsApp-brand-green belongs to the WhatsApp Cloud API
              itself, not the CRM CTAs. Use btn-primary + no inline
              overrides so it renders canonical teal var(--brand). */}
          <button onClick={() => setShowComposeWa(true)} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <MessageCircle size={18} /> Compose WhatsApp
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
              <div
                key={msg.id}
                onClick={() => setDetail({ kind: 'sms', item: msg })}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetail({ kind: 'sms', item: msg }); } }}
                className={`table-row-hover inbox-bubble inbox-bubble--sms ${msg.direction === 'INBOUND' ? 'inbox-bubble--inbound' : ''}`}
                style={{ padding: '1.25rem', border: '1px solid var(--border-color)', borderRadius: '12px', display: 'flex', gap: '1rem', alignItems: 'flex-start', cursor: 'pointer' }}
              >
                <div className="inbox-avatar inbox-avatar--sms" style={{ width: '36px', height: '36px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <MessageSquare size={18} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.375rem' }}>
                    <span style={{ fontWeight: '600' }}>{msg.direction === 'INBOUND' ? msg.from || msg.to : msg.to}</span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{new Date(msg.createdAt).toLocaleString()}</span>
                  </div>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{msg.body}</p>
                  <span className={`inbox-status-pill inbox-status-pill--${(msg.status === 'DELIVERED' ? 'delivered' : msg.status === 'FAILED' ? 'failed' : 'pending')}`} style={{ marginTop: '0.375rem' }}>{msg.status}</span>
                </div>
              </div>
            ))}
          </div>
        ) : activeTab === 'whatsapp' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {waMessages.length === 0 && <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>No WhatsApp messages yet. Configure WhatsApp in Settings &gt; Channels.</p>}
            {waMessages.map(msg => (
              <div
                key={msg.id}
                onClick={() => setDetail({ kind: 'wa', item: msg })}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetail({ kind: 'wa', item: msg }); } }}
                className={`table-row-hover inbox-bubble inbox-bubble--wa ${msg.direction === 'INBOUND' ? 'inbox-bubble--inbound' : ''}`}
                style={{ padding: '1.25rem', border: '1px solid var(--border-color)', borderRadius: '12px', display: 'flex', gap: '1rem', alignItems: 'flex-start', cursor: 'pointer' }}
              >
                <div className="inbox-avatar inbox-avatar--wa" style={{ width: '36px', height: '36px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <MessageCircle size={18} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.375rem' }}>
                    <span style={{ fontWeight: '600' }}>{msg.direction === 'INBOUND' ? msg.from || msg.to : msg.to}</span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{new Date(msg.createdAt).toLocaleString()}</span>
                  </div>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{msg.body || `Template: ${msg.templateName}`}</p>
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.375rem', alignItems: 'center' }}>
                    <span className={`inbox-status-pill inbox-status-pill--${(msg.status === 'READ' ? 'read' : msg.status === 'DELIVERED' ? 'delivered' : msg.status === 'FAILED' ? 'failed' : 'pending')}`}>{msg.status}</span>
                    {msg.status === 'READ' && <span className="inbox-read-receipt">✓✓</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : activeTab === 'emails' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* #624 — folder sub-tabs (All / Inbox / Sent). Backend filter
                is applied via /api/communications/inbox?folder=<v>. The
                Sent folder was the bug surface in #624: pre-fix there was
                no UI to view OUTBOUND-only mail; the backend has always
                stored direction='OUTBOUND' on every send-email call. */}
            <div role="tablist" aria-label="Email folder" style={{ display: 'flex', gap: '0.25rem', padding: '0.25rem', background: 'rgba(0,0,0,0.15)', borderRadius: '8px', alignSelf: 'flex-start' }}>
              {[
                { id: 'all', label: 'All' },
                { id: 'inbox', label: 'Inbox' },
                { id: 'sent', label: 'Sent' },
              ].map(f => (
                <button
                  key={f.id}
                  role="tab"
                  aria-selected={emailFolder === f.id}
                  onClick={() => setEmailFolder(f.id)}
                  style={{
                    padding: '0.4rem 1rem',
                    border: 'none',
                    background: emailFolder === f.id ? 'var(--accent-color)' : 'transparent',
                    color: emailFolder === f.id ? '#fff' : 'var(--text-secondary)',
                    fontWeight: emailFolder === f.id ? 600 : 500,
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '0.85rem',
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
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
              <div key={email.id} className="table-row-hover" onClick={() => setDetail({ kind: 'email', item: email })} style={{ padding: '1.5rem', border: '1px solid var(--border-color)', borderRadius: '12px', background: email.read ? 'rgba(0,0,0,0.2)' : 'rgba(59, 130, 246, 0.05)', display: 'flex', gap: '1.5rem', cursor: 'pointer' }}>
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
              <div
                key={call.id}
                onClick={() => setDetail({ kind: 'call', item: call })}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetail({ kind: 'call', item: call }); } }}
                className="table-row-hover"
                style={{ padding: '1.5rem', border: '1px solid var(--border-color)', borderRadius: '12px', background: 'var(--table-header-bg)', display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap', cursor: 'pointer' }}
              >
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
                        onClick={(e) => e.stopPropagation()}
                        style={{ height: 36 }}
                      />
                    )
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); setPlayingCallId(call.id); }}
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
        <div
          onClick={(e) => { if (e.target === e.currentTarget) closeCompose(); }}
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, animation: 'fadeIn 0.2s ease-out' }}
        >
          <div className="card" style={{ padding: '2rem 2.25rem', width: '600px', border: '1px solid var(--border-color)', boxShadow: '0 20px 40px rgba(0,0,0,0.5)', position: 'relative' }}>
            <button
              type="button"
              onClick={closeCompose}
              aria-label="Close"
              style={{
                position: 'absolute',
                top: '1rem',
                right: '1rem',
                width: 32,
                height: 32,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'transparent',
                border: 'none',
                borderRadius: 6,
                color: 'var(--text-secondary)',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-color)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
            >
              <X size={18} />
            </button>
            <h3 style={{ marginBottom: '1.5rem', fontSize: '1.25rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.55rem', paddingRight: '2rem' }}>
              <Mail size={20} color="var(--accent-color)" /> New Message
            </h3>
            <form onSubmit={handleSendEmail} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <label style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>To:</label>
                  {/* #623 — Cc/Bcc toggle. Hidden by default to keep the
                      composer minimal; clicking expands the two fields below. */}
                  {!showCcBcc && (
                    <button
                      type="button"
                      onClick={() => setShowCcBcc(true)}
                      aria-label="Show Cc and Bcc"
                      style={{ background: 'transparent', border: 'none', color: 'var(--accent-color)', fontSize: '0.8rem', cursor: 'pointer', padding: 0 }}
                    >
                      Cc / Bcc
                    </button>
                  )}
                </div>
                <div style={{ position: 'relative' }}>
                  <input
                    type="text"
                    required
                    className="input-field"
                    value={composeData.to}
                    onChange={e => { setComposeData({ ...composeData, to: e.target.value }); setShowToDropdown(true); }}
                    onFocus={() => setShowToDropdown(true)}
                    onBlur={() => setTimeout(() => setShowToDropdown(false), 120)}
                    onKeyDown={(e) => { if (e.key === 'Escape') setShowToDropdown(false); }}
                    placeholder="client@company.com (comma-separated for multiple)"
                    autoComplete="off"
                    aria-autocomplete="list"
                    aria-expanded={showToDropdown && filteredToContacts.length > 0}
                  />
                  {showToDropdown && filteredToContacts.length > 0 && (
                    <ul
                      role="listbox"
                      style={{
                        position: 'absolute',
                        top: 'calc(100% + 4px)',
                        left: 0,
                        right: 0,
                        margin: 0,
                        padding: '0.25rem 0',
                        listStyle: 'none',
                        // --tooltip-bg is the canonical near-solid popover
                        // surface in this app (dark navy in dark mode, near-white
                        // in light mode) so the dropdown stays legible against
                        // the semi-transparent modal underneath.
                        background: 'var(--tooltip-bg)',
                        backdropFilter: 'blur(8px)',
                        WebkitBackdropFilter: 'blur(8px)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 6,
                        boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
                        maxHeight: 260,
                        overflowY: 'auto',
                        zIndex: 10,
                      }}
                    >
                      {filteredToContacts.map((c) => (
                        <li
                          key={c.id}
                          role="option"
                          // onMouseDown + preventDefault stops the input from
                          // blurring before the click registers — without this
                          // the dropdown closes before onClick fires.
                          onMouseDown={(e) => { e.preventDefault(); handleSelectToContact(c.email); }}
                          style={{
                            padding: '0.5rem 0.75rem',
                            cursor: 'pointer',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 2,
                            borderRadius: 4,
                            margin: '0 0.25rem',
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-color)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        >
                          <span style={{ color: 'var(--text-primary)', fontSize: '0.875rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {c.email}
                          </span>
                          {c.name && (
                            <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {c.name}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
              {showCcBcc && (
                <>
                  <div>
                    <label htmlFor="compose-cc" style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Cc:</label>
                    <input id="compose-cc" type="text" className="input-field" value={composeData.cc} onChange={e => setComposeData({...composeData, cc: e.target.value})} placeholder="cc@company.com (comma-separated)" />
                  </div>
                  <div>
                    <label htmlFor="compose-bcc" style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Bcc:</label>
                    <input id="compose-bcc" type="text" className="input-field" value={composeData.bcc} onChange={e => setComposeData({...composeData, bcc: e.target.value})} placeholder="bcc@company.com (comma-separated)" />
                  </div>
                </>
              )}
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Subject:</label>
                <input type="text" required className="input-field" value={composeData.subject} onChange={e => setComposeData({...composeData, subject: e.target.value})} placeholder="Following up" />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Message:</label>
                <textarea required className="input-field" value={composeData.body} onChange={e => setComposeData({...composeData, body: e.target.value})} placeholder="Write your email here..." rows={6} style={{ resize: 'vertical' }} />
              </div>

              {/* Attachments — paperclip opens the native file picker; selected
                  files render as removable chips. Sent as multipart
                  `attachments[]` in handleSendEmail; max 5 files / 10 MB each. */}
              <div>
                <input
                  ref={composeFileInputRef}
                  type="file"
                  multiple
                  accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain,application/zip,.jpg,.jpeg,.png,.gif,.webp,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip"
                  onChange={handlePickAttachments}
                  style={{ display: 'none' }}
                />
                <button
                  type="button"
                  onClick={() => composeFileInputRef.current?.click()}
                  disabled={composeAttachments.length >= MAX_ATTACHMENTS}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    padding: '0.4rem 0.75rem',
                    background: 'transparent',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    color: 'var(--text-secondary)',
                    fontSize: '0.8rem',
                    cursor: composeAttachments.length >= MAX_ATTACHMENTS ? 'not-allowed' : 'pointer',
                    opacity: composeAttachments.length >= MAX_ATTACHMENTS ? 0.6 : 1,
                  }}
                >
                  <Paperclip size={14} /> Attach files
                  {composeAttachments.length > 0 && (
                    <span style={{ color: 'var(--accent-color)', fontWeight: 600 }}>
                      ({composeAttachments.length}/{MAX_ATTACHMENTS})
                    </span>
                  )}
                </button>
                {composeAttachments.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.6rem' }}>
                    {composeAttachments.map((f, i) => (
                      <div
                        key={`${f.name}-${i}`}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.4rem',
                          padding: '0.3rem 0.6rem',
                          background: 'rgba(59, 130, 246, 0.08)',
                          border: '1px solid rgba(59, 130, 246, 0.3)',
                          borderRadius: '14px',
                          fontSize: '0.75rem',
                          color: 'var(--text-primary)',
                          maxWidth: '100%',
                        }}
                      >
                        <Paperclip size={12} color="var(--accent-color)" />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '180px' }}>
                          {f.name}
                        </span>
                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem' }}>
                          {formatAttachmentSize(f.size)}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleRemoveAttachment(i)}
                          aria-label={`Remove ${f.name}`}
                          style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 0, display: 'inline-flex', alignItems: 'center' }}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
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

              {/* Action row — refined for a professional feel: muted ghost
                  buttons for the secondary tools, single accent-filled primary
                  on the right. Discard removed; the header X owns dismissal. */}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.75rem', paddingTop: '1rem', borderTop: '1px solid var(--border-color)', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <select
                    value={aiTone}
                    onChange={e => setAiTone(e.target.value)}
                    aria-label="AI tone"
                    style={{
                      padding: '0.45rem 0.6rem',
                      fontSize: '0.8rem',
                      width: 'auto',
                      background: 'var(--input-bg)',
                      color: 'var(--text-primary)',
                      border: '1px solid var(--border-color)',
                      borderRadius: 6,
                      cursor: 'pointer',
                    }}
                  >
                    <option value="professional">Professional</option>
                    <option value="friendly">Friendly</option>
                    <option value="formal">Formal</option>
                    <option value="casual">Casual</option>
                    <option value="persuasive">Persuasive</option>
                    <option value="concise">Concise</option>
                  </select>
                  <button
                    type="button"
                    onClick={handleAIGenerate}
                    disabled={aiLoading}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      padding: '0.45rem 0.85rem',
                      fontSize: '0.8rem',
                      fontWeight: 500,
                      background: 'transparent',
                      border: '1px solid var(--border-color)',
                      borderRadius: 6,
                      color: 'var(--text-primary)',
                      cursor: aiLoading ? 'wait' : 'pointer',
                      opacity: aiLoading ? 0.7 : 1,
                    }}
                  >
                    <Sparkles size={14} color="var(--accent-color)" />
                    {aiLoading ? 'Generating…' : 'AI Draft'}
                  </button>
                  <button
                    type="button"
                    onClick={handleAISubjects}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      padding: '0.45rem 0.85rem',
                      fontSize: '0.8rem',
                      fontWeight: 500,
                      background: 'transparent',
                      border: '1px solid var(--border-color)',
                      borderRadius: 6,
                      color: 'var(--text-primary)',
                      cursor: 'pointer',
                    }}
                  >
                    <Lightbulb size={14} color="var(--text-secondary)" />
                    Subjects
                  </button>
                </div>
                <button type="submit" className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', padding: '0.55rem 1.1rem', fontWeight: 500 }}>
                  <Send size={16} /> Send Email
                </button>
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

      {showCallDial && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, animation: 'fadeIn 0.2s ease-out' }}>
          <div className="card" style={{ padding: '2.5rem', width: '500px', border: '1px solid rgba(38, 88, 85, 0.3)', boxShadow: '0 20px 40px rgba(0,0,0,0.5)' }}>
            <h3 style={{ marginBottom: '1.5rem', fontSize: '1.5rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Phone size={24} color="var(--accent-color)" /> Initiate Call
            </h3>
            <form onSubmit={handleInitiateCall} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Select Contact:</label>
                <select required className="input-field" value={callDialData.contactId} onChange={e => setCallDialData({...callDialData, contactId: e.target.value})}>
                  <option value="">-- Select Contact --</option>
                  {contacts.map(c => <option key={c.id} value={c.id}>{c.name} ({c.email || c.phone})</option>)}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Notes (optional):</label>
                <textarea className="input-field" value={callDialData.notes} onChange={e => setCallDialData({...callDialData, notes: e.target.value})} placeholder="Add call notes..." rows={3} style={{ resize: 'vertical' }} />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem', gap: '1rem' }}>
                <button type="button" onClick={() => setShowCallDial(false)} style={{ background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer', fontWeight: '500' }}>Cancel</button>
                <button type="submit" className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Phone size={16} /> Start Call
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* #460: Row-detail modal — shared across email/call/sms/whatsapp tabs.
          Renders the full body, headers, status, and (for calls) the recording.
          NOTE: PR #512 (squash-merge 8b59fcb) accidentally dropped this block
          while keeping setDetail() callsites. PR #511's rebase restores it. */}
      {detail && (
        <div onClick={() => setDetail(null)} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, animation: 'fadeIn 0.2s ease-out' }}>
          <div onClick={(e) => e.stopPropagation()} className="card" style={{ padding: '2.5rem', width: '640px', maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 20px 40px rgba(0,0,0,0.5)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                {detail.kind === 'email' && <><Mail size={20} color="var(--accent-color)" /> Email</>}
                {detail.kind === 'call' && <><Phone size={20} color="var(--warning-color)" /> Call Log</>}
                {detail.kind === 'sms' && <><MessageSquare size={20} color="#10b981" /> SMS Message</>}
                {detail.kind === 'wa' && <><MessageCircle size={20} color="#25D366" /> WhatsApp Message</>}
              </h3>
              <button onClick={() => setDetail(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }} aria-label="Close">
                <X size={20} />
              </button>
            </div>
            {detail.kind === 'email' && (
              <div>
                {/* Avatar + from/to row — ported from the previous selectedEmail
                    modal (PR #511 #7 consolidation). Same visual hierarchy
                    sms/wa/call branches use, just with the email-specific
                    sender card on top. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.25rem' }}>
                  <div style={{ width: '50px', height: '50px', borderRadius: '50%', background: 'var(--primary-color, var(--accent-color))', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <User size={24} color="#fff" />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: '1.05rem', fontWeight: 'bold', margin: 0, marginBottom: '0.15rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={detail.item.from}>{detail.item.from}</p>
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={detail.item.to}>to {detail.item.to}</p>
                  </div>
                </div>
                <h2 style={{ fontSize: '1.4rem', fontWeight: 'bold', margin: 0, marginBottom: '0.4rem' }}>{detail.item.subject}</h2>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0, marginBottom: '1.25rem' }}>{new Date(detail.item.createdAt).toLocaleString()}</p>
                <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1.25rem', whiteSpace: 'pre-wrap', wordWrap: 'break-word', lineHeight: 1.65, color: 'var(--text-primary)' }}>
                  {detail.item.body || <em style={{ color: 'var(--text-secondary)' }}>(empty body)</em>}
                </div>
              </div>
            )}
            {detail.kind === 'call' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}><strong>Direction:</strong> {detail.item.direction}</div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}><strong>Duration:</strong> {detail.item.duration ?? 0} seconds</div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}><strong>From:</strong> {detail.item.callerNumber || '—'}</div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}><strong>To:</strong> {detail.item.calleeNumber || '—'}</div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}><strong>Status:</strong> {detail.item.status || '—'}</div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}><strong>When:</strong> {new Date(detail.item.createdAt).toLocaleString()}</div>
                {detail.item.notes && (
                  <div style={{ marginTop: '0.5rem', whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>
                    <strong style={{ display: 'block', marginBottom: '0.25rem' }}>Notes</strong>
                    {detail.item.notes}
                  </div>
                )}
                {detail.item.recordingUrl && (
                  <div style={{ marginTop: '0.5rem' }}>
                    <strong style={{ display: 'block', marginBottom: '0.25rem' }}>Recording</strong>
                    <audio controls src={detail.item.recordingUrl} style={{ width: '100%' }} />
                  </div>
                )}
              </div>
            )}
            {(detail.kind === 'sms' || detail.kind === 'wa') && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}><strong>Direction:</strong> {detail.item.direction}</div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}><strong>From:</strong> {detail.item.from || '—'}</div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}><strong>To:</strong> {detail.item.to || '—'}</div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}><strong>Status:</strong> {detail.item.status || '—'}</div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}><strong>When:</strong> {new Date(detail.item.createdAt).toLocaleString()}</div>
                {detail.kind === 'wa' && detail.item.templateName && (
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}><strong>Template:</strong> {detail.item.templateName}</div>
                )}
                <div style={{ marginTop: '0.5rem', whiteSpace: 'pre-wrap', lineHeight: 1.55, padding: '0.75rem 1rem', borderRadius: '8px', background: detail.kind === 'wa' ? 'rgba(37, 211, 102, 0.06)' : 'rgba(16, 185, 129, 0.06)' }}>
                  {detail.item.body || <em style={{ color: 'var(--text-secondary)' }}>(no body — template only)</em>}
                </div>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
              <button onClick={() => setDetail(null)} className="btn-secondary">Close</button>
            </div>
          </div>
        </div>
      )}

      {showComposeSms && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, animation: 'fadeIn 0.2s ease-out' }}>
          <div className="card" style={{ padding: '2.5rem', width: '600px', border: '1px solid rgba(16, 185, 129, 0.3)', boxShadow: '0 20px 40px rgba(0,0,0,0.5)' }}>
            <h3 style={{ marginBottom: '1.5rem', fontSize: '1.5rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <MessageSquare size={24} color="#10b981" /> New SMS Message
            </h3>
            <form onSubmit={handleSendSms} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Phone Number:</label>
                <input type="tel" required className="input-field" value={composeSmsData.to} onChange={e => setComposeSmsData({...composeSmsData, to: e.target.value})} placeholder="+91 XXXXXXXXXX" />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Message:</label>
                <textarea required className="input-field" value={composeSmsData.body} onChange={e => setComposeSmsData({...composeSmsData, body: e.target.value})} placeholder="Type your SMS message here..." rows={4} style={{ resize: 'vertical' }} />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem', display: 'block' }}>Character count: {composeSmsData.body.length}/160</span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem', gap: '1rem' }}>
                <button type="button" onClick={() => setShowComposeSms(false)} style={{ background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer', fontWeight: '500' }}>Discard</button>
                <button type="submit" className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Send size={16} /> Send SMS
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* #594 — Compose WhatsApp modal. Channel-specific entry: To field is
          a phone number (E.164 expected by Meta Cloud API), body is plain
          text, POST to /api/whatsapp/send. Email-specific fields (subject,
          cc/bcc) are intentionally absent. */}
      {showComposeWa && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, animation: 'fadeIn 0.2s ease-out' }}>
          <div className="card" style={{ padding: '2.5rem', width: '600px', border: '1px solid rgba(37, 211, 102, 0.3)', boxShadow: '0 20px 40px rgba(0,0,0,0.5)' }}>
            <h3 style={{ marginBottom: '1.5rem', fontSize: '1.5rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <MessageCircle size={24} color="#25D366" /> New WhatsApp Message
            </h3>
            <form onSubmit={handleSendWa} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label htmlFor="compose-wa-to" style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Phone Number (E.164):</label>
                <input
                  id="compose-wa-to"
                  type="tel"
                  required
                  list="contacts-phone-list"
                  className="input-field"
                  value={composeWaData.to}
                  onChange={e => setComposeWaData({ ...composeWaData, to: e.target.value })}
                  placeholder="+919876543210"
                />
                <datalist id="contacts-phone-list">
                  {contacts.filter(c => c.phone).map(c => (
                    <option key={c.id} value={c.phone}>{c.name}</option>
                  ))}
                </datalist>
              </div>
              <div>
                <label htmlFor="compose-wa-body" style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Message:</label>
                <textarea
                  id="compose-wa-body"
                  required
                  className="input-field"
                  value={composeWaData.body}
                  onChange={e => setComposeWaData({ ...composeWaData, body: e.target.value })}
                  placeholder="Type your WhatsApp message here..."
                  rows={5}
                  style={{ resize: 'vertical' }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem', gap: '1rem' }}>
                <button type="button" onClick={() => { setShowComposeWa(false); setComposeWaData({ to: '', body: '' }); }} style={{ background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer', fontWeight: '500' }}>Discard</button>
                {/* #726 — was solid #25D366 (WhatsApp brand green) among
                    teal Send Email / Send SMS submits. Drop the inline
                    overrides so btn-primary renders the canonical teal. */}
                <button type="submit" disabled={waSending} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Send size={16} /> {waSending ? 'Sending…' : 'Send WhatsApp'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
