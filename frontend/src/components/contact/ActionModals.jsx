import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bold, Italic, Underline, Strikethrough, List, ListOrdered, AlignLeft, AlignCenter, AlignRight, AlignJustify, Indent, Outdent, Image, Smile, Link2, RemoveFormatting, Paperclip, Send, Trash2, ChevronDown, Info, PackagePlus, Plus, X } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { tenantCurrency } from '../../utils/money';
import {
  createDeal, createTask, postActivity, sendEmail, sendSms, sendWhatsapp,
  syncMeetingToCalendar, updateDeal,
} from './contactActions';
import { ACTIVITY_TYPES, DEAL_STAGES } from './contactProfileConfig';
import { FormRow, Modal } from './ProfileWidgets';

function todayPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 16);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAIL_MAX_FILES = 5;
const MAIL_MAX_BYTES = 10 * 1024 * 1024;
const MAIL_ALLOWED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'text/plain', 'application/zip']);
function mailSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function EmailModal({ contact, onClose, onDone }) {
  const notify = useNotify();
  const [toList, setToList] = useState(() => (contact?.email ? [contact.email] : []));
  const [toText, setToText] = useState('');
  const [ccList, setCcList] = useState([]);
  const [ccText, setCcText] = useState('');
  const [bccList, setBccList] = useState([]);
  const [bccText, setBccText] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState('');
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState([]);
  const [draftNote, setDraftNote] = useState('');
  const [fontName, setFontName] = useState('Arial');
  const [fontPx, setFontPx] = useState('14');
  const [trackEmail, setTrackEmail] = useState(false);
  const [addUnsub, setAddUnsub] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const editorRef = useRef(null);
  const fileRef = useRef(null);
  const draftKey = `contact-email-draft-${contact?.id ?? 'new'}`;
  const FONT_PX_TO_CMD = { 10: '1', 12: '2', 14: '3', 16: '4', 18: '5', 20: '6', 24: '6', 28: '7', 32: '7' };
  const commitMails = (raw, list, setList) => {
    const parts = String(raw).split(/[,\n;]/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...list];
    for (const p of parts) {
      if (!EMAIL_RE.test(p)) { notify.error(`"${p}" is not a valid email address.`); continue; }
      if (!next.some((r) => r.toLowerCase() === p.toLowerCase())) next.push(p);
    }
    setList(next);
  };
  const exec = useCallback((cmd, value = null) => {
    editorRef.current?.focus();
    try { document.execCommand(cmd, false, value); } catch { /* ignore */ }
  }, []);
  const addLink = useCallback(async () => {
    const sel = window.getSelection();
    const selected = sel && !sel.isCollapsed ? String(sel.toString()) : '';
    const raw = window.prompt('Link URL', 'https://');
    if (raw === null) return;
    const v = String(raw).trim();
    const url = /^https?:\/\//i.test(v) ? v : `https://${v}`;
    try { new URL(url); } catch { notify.error('Please enter a valid http(s) URL.'); return; }
    editorRef.current?.focus();
    try {
      if (selected) document.execCommand('createLink', false, url);
      else document.execCommand('insertHTML', false, `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    } catch { /* ignore */ }
  }, [notify]);
  const addImage = useCallback(async () => {
    const raw = window.prompt('Image URL', 'https://');
    if (raw === null) return;
    const url = String(raw).trim();
    if (!/^https?:\/\/.+/i.test(url)) { notify.error('Please enter a valid http(s) image URL.'); return; }
    editorRef.current?.focus();
    try { document.execCommand('insertHTML', false, `<img src="${url}" alt="" style="max-width:100%;height:auto;" />`); } catch { /* ignore */ }
  }, [notify]);
  const insertEmoji = (ch) => {
    editorRef.current?.focus();
    try { document.execCommand('insertText', false, ch); } catch { /* ignore */ }
    setEmojiOpen(false);
  };
  const saveDraft = useCallback((silent) => {
    try {
      localStorage.setItem(draftKey, JSON.stringify({ toList, ccList, bccList, subject, bodyHtml: editorRef.current?.innerHTML || '', trackEmail, addUnsub, savedAt: new Date().toISOString() }));
      setDraftNote(`Draft saved ${new Date().toLocaleTimeString()}`);
      if (!silent) notify.success('Draft saved.');
    } catch { if (!silent) notify.error('Could not save draft.'); }
  }, [draftKey, toList, ccList, bccList, subject, trackEmail, addUnsub, notify]);
  const deleteDraft = () => {
    try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
    setSubject('');
    setFiles([]);
    setTrackEmail(false);
    setAddUnsub(false);
    if (editorRef.current) editorRef.current.innerHTML = '';
    setDraftNote('');
    notify.success('Draft discarded.');
  };
  useEffect(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) {
        const d = JSON.parse(raw);
        if (typeof d.subject === 'string' && d.subject) setSubject(d.subject);
        if (typeof d.bodyHtml === 'string' && d.bodyHtml && editorRef.current && !editorRef.current.innerText.trim()) editorRef.current.innerHTML = d.bodyHtml;
        if (Array.isArray(d.ccList) && d.ccList.length) { setCcList(d.ccList.filter((x) => EMAIL_RE.test(x))); setShowCc(true); }
        if (Array.isArray(d.bccList) && d.bccList.length) { setBccList(d.bccList.filter((x) => EMAIL_RE.test(x))); setShowBcc(true); }
        if (d.savedAt) setDraftNote(`Draft saved ${new Date(d.savedAt).toLocaleTimeString()}`);
        if (typeof d.trackEmail === 'boolean') setTrackEmail(d.trackEmail);
        if (typeof d.addUnsub === 'boolean') setAddUnsub(d.addUnsub);
      }
    } catch { /* no usable draft */ }
  }, [draftKey]);
  const addFiles = (picked) => {
    const list = Array.from(picked || []);
    if (!list.length) return;
    setFiles((prev) => {
      const left = MAIL_MAX_FILES - prev.length;
      if (left <= 0) { notify.error(`You can attach up to ${MAIL_MAX_FILES} files.`); return prev; }
      const ok = [];
      for (const f of list) {
        if (ok.length >= left) break;
        if (f.size > MAIL_MAX_BYTES) { notify.error(`"${f.name}" exceeds ${mailSize(MAIL_MAX_BYTES)}.`); continue; }
        if (f.type && !MAIL_ALLOWED.has(f.type) && !/\.(pdf|doc|docx|xls|xlsx|csv|txt|zip|jpe?g|png|gif|webp)$/i.test(f.name)) { notify.error(`"${f.name}" type not allowed.`); continue; }
        ok.push(f);
      }
      return [...prev, ...ok].slice(0, MAIL_MAX_FILES);
    });
  };
  useEffect(() => {
    const has = toList.length > 0 || subject.trim() || editorRef.current?.innerText.trim();
    if (!has) return;
    const t = setTimeout(() => saveDraft(true), 2000);
    return () => clearTimeout(t);
  }, [toList, subject, saveDraft]);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
      else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const send = async () => {
    if (sending) return;
    const validTo = toList.filter((r) => EMAIL_RE.test(r));
    if (!validTo.length) { notify.error('Add at least one valid recipient.'); return; }
    if (!subject.trim()) { notify.error('Subject is required.'); return; }
    let html = editorRef.current?.innerHTML || '';
    if (!editorRef.current?.innerText.trim()) { notify.error('Email body is empty.'); return; }
    if (addUnsub && !/unsubscribe/i.test(editorRef.current?.innerText || '')) {
      html += '<br><br><small style="color:#6b7280">Reply UNSUBSCRIBE to opt out of these emails.</small>';
    }
    setSending(true);
    try {
      if (files.length > 0) {
        const fd = new FormData();
        fd.append('to', validTo.join(', '));
        if (ccList.length) fd.append('cc', ccList.join(', '));
        if (bccList.length) fd.append('bcc', bccList.join(', '));
        fd.append('subject', subject.trim());
        fd.append('body', html);
        if (contact?.id) fd.append('contactId', String(contact.id));
        for (const f of files) fd.append('attachments', f, f.name);
        await fetchApi('/api/communications/send-email', { method: 'POST', body: fd });
      } else {
        await sendEmail({ to: validTo.join(', '), cc: ccList.join(', ') || undefined, bcc: bccList.join(', ') || undefined, subject: subject.trim(), body: html, contactId: contact?.id });
      }
      await postActivity(contact.id, { type: 'Email', description: `Email sent: ${subject.trim()}${trackEmail ? ' (tracked)' : ''}` }).catch(() => null);
      try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
      notify.success('Email sent successfully.');
      onDone();
      onClose();
    } catch (err) {
      notify.error(err?.message || 'Failed to send email. Please try again.');
    } finally {
      setSending(false);
    }
  };
  const chip = (mail, remove) => (
    <span key={mail} className="cp-task-chip"><span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: '50%', background: '#f3d1e0', color: '#7a2e4a', fontSize: 11, fontWeight: 700 }}>{String(mail).charAt(0).toUpperCase()}</span>{mail} <button type="button" aria-label={`Remove ${mail}`} onClick={remove}><X size={12} /></button></span>
  );
  const mailRow = (list, setList, text, setText, placeholder) => (
    <div className="cp-input" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', alignItems: 'center', minHeight: '2.4rem', cursor: 'text' }} onClick={(e) => { const el = e.currentTarget.querySelector('input'); if (el && e.target !== el) el.focus(); }}>
      {list.map((m) => chip(m, () => setList(list.filter((x) => x !== m))))}
      <input value={text} onChange={(e) => { const v = e.target.value; if (v.includes(',') || v.includes(';')) { commitMails(v, list, setList); setText(''); } else setText(v); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); commitMails(text, list, setList); setText(''); } else if (e.key === 'Backspace' && !text && list.length) setList(list.slice(0, -1)); }} onBlur={() => { if (text.trim()) { commitMails(text, list, setList); setText(''); } }} placeholder={list.length ? '' : placeholder} aria-label={placeholder} autoComplete="off" style={{ flex: 1, minWidth: 140, border: 'none', outline: 'none', background: 'transparent', fontSize: '0.85rem' }} />
    </div>
  );
  const tBtn = (title, fn, icon) => (
    <button key={title} type="button" title={title} aria-label={title} onMouseDown={(e) => { e.preventDefault(); fn(); }} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 26, height: 26, border: 'none', background: 'none', borderRadius: 5, cursor: 'pointer', color: 'inherit' }}>{icon}</button>
  );
  return createPortal((
    <div className="cp-task-overlay cp-email-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="New mail">
      <aside className="cp-meeting-drawer" style={{ width: '72vw', maxWidth: 1100 }} onClick={(e) => e.stopPropagation()}>
        <header className="cp-task-head"><h3>New mail</h3><button type="button" className="cp-icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button></header>
        <div className="cp-meeting-body" style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', minHeight: 0, flexShrink: 1, padding: '0.75rem 1.25rem' }}>
          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}><span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', width: 24 }}>To</span><div style={{ flex: 1 }}>{mailRow(toList, setToList, toText, setToText, contact?.name || 'Recipients')}</div></div>
              {showCc && <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}><span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', width: 24 }}>Cc</span><div style={{ flex: 1 }}>{mailRow(ccList, setCcList, ccText, setCcText, 'Cc')}</div></div>}
              {showBcc && <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}><span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', width: 24 }}>Bcc</span><div style={{ flex: 1 }}>{mailRow(bccList, setBccList, bccText, setBccText, 'Bcc')}</div></div>}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.78rem', paddingTop: '0.5rem' }}>
              <span style={{ color: 'var(--text-secondary)' }}>From</span>
              {!showCc && <button type="button" onClick={() => setShowCc(true)} style={{ border: 'none', background: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.78rem' }}>Cc</button>}
              {!showBcc && <button type="button" onClick={() => setShowBcc(true)} style={{ border: 'none', background: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.78rem' }}>Bcc</button>}
            </div>
          </div>
          <input className="cp-input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Write a subject line" aria-label="Subject" style={{ border: 'none', borderBottom: '1px solid var(--border-color)', borderRadius: 0, paddingLeft: 0 }} />
          <div ref={editorRef} contentEditable role="textbox" aria-label="Email body" data-placeholder="Start typing your email..." onDrop={(e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); e.stopPropagation(); addFiles(e.dataTransfer.files); } }} style={{ flex: 1, minHeight: '12vh', maxHeight: '30vh', outline: 'none', fontSize: '0.9rem', lineHeight: 1.55, overflowY: 'auto' }} />
          {files.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>{files.map((f, i) => <span key={`${f.name}-${i}`} className="cp-task-chip">📎 {f.name} · {mailSize(f.size)} <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((p) => p.filter((_, x) => x !== i))}><X size={12} /></button></span>)}</div>}
        </div>
        <footer style={{ borderTop: '1px solid var(--border-color)', background: '#fff', flexShrink: 0 }}>
          <div role="toolbar" aria-label="Formatting" style={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', color: 'var(--text-secondary)', padding: '0.25rem 1.25rem', borderBottom: '1px solid var(--border-color)' }}>
            <select aria-label="Font" value={fontName} onChange={(e) => { setFontName(e.target.value); exec('fontName', e.target.value); }} style={{ border: 'none', background: 'none', fontSize: '0.75rem', color: 'inherit', cursor: 'pointer', maxWidth: 90 }}>
              {['Arial', 'Georgia', 'Times New Roman', 'Verdana', 'Courier New'].map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <select aria-label="Font size" value={fontPx} onChange={(e) => { setFontPx(e.target.value); exec('fontSize', FONT_PX_TO_CMD[e.target.value] || '3'); }} style={{ border: 'none', background: 'none', fontSize: '0.75rem', color: 'inherit', cursor: 'pointer' }}>
              {['10', '12', '14', '16', '18', '20', '24', '28'].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            {tBtn('Bold', () => exec('bold'), <Bold size={14} />)}
            {tBtn('Italic', () => exec('italic'), <Italic size={14} />)}
            {tBtn('Underline', () => exec('underline'), <Underline size={14} />)}
            {tBtn('Strikethrough', () => exec('strikeThrough'), <Strikethrough size={14} />)}
            <label title="Text color" style={{ display: 'inline-flex', cursor: 'pointer', padding: '0 2px' }}><span style={{ fontWeight: 700, fontSize: 13 }}>A</span><input type="color" aria-label="Text color" onChange={(e) => exec('foreColor', e.target.value)} style={{ width: 0, height: 0, opacity: 0, position: 'absolute', pointerEvents: 'none' }} /></label>
            <label title="Highlight color" style={{ display: 'inline-flex', cursor: 'pointer', padding: '0 2px' }}><span style={{ fontWeight: 700, fontSize: 13, background: '#fef08a', borderRadius: 3, padding: '0 3px' }}>A</span><input type="color" aria-label="Highlight color" defaultValue="#fef08a" onChange={(e) => exec('hiliteColor', e.target.value)} style={{ width: 0, height: 0, opacity: 0, position: 'absolute', pointerEvents: 'none' }} /></label>
            {tBtn('Insert image', addImage, <Image size={14} />)}
            {tBtn('Insert link', addLink, <Link2 size={14} />)}
            {tBtn('Align left', () => exec('justifyLeft'), <AlignLeft size={14} />)}
            {tBtn('Align center', () => exec('justifyCenter'), <AlignCenter size={14} />)}
            {tBtn('Align right', () => exec('justifyRight'), <AlignRight size={14} />)}
            {tBtn('Justify', () => exec('justifyFull'), <AlignJustify size={14} />)}
            {tBtn('Bulleted list', () => exec('insertUnorderedList'), <List size={14} />)}
            {tBtn('Numbered list', () => exec('insertOrderedList'), <ListOrdered size={14} />)}
            {tBtn('Indent', () => exec('indent'), <Indent size={14} />)}
            {tBtn('Outdent', () => exec('outdent'), <Outdent size={14} />)}
            {tBtn('Remove formatting', () => exec('removeFormat'), <RemoveFormatting size={14} />)}
          </div>
          <div className="cp-meeting-footer" style={{ alignItems: 'center', borderTop: 'none', padding: '0.5rem 1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <input ref={fileRef} type="file" multiple onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} style={{ display: 'none' }} />
              <button type="button" className="cp-action-btn" onClick={() => fileRef.current?.click()}><Paperclip size={13} /> Attach{files.length > 0 && ` (${files.length})`}</button>
              <div style={{ position: 'relative' }}>
                <button type="button" className="cp-icon-btn" title="Insert emoji" aria-label="Insert emoji" onClick={() => setEmojiOpen((v) => !v)}><Smile size={15} /></button>
                {emojiOpen && <div style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 40, background: '#fff', border: '1px solid var(--border-color)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', padding: 6, display: 'flex', gap: 2, flexWrap: 'wrap', width: 210 }}>{['😊', '👍', '🎉', '🙏', '✅', '📎', '📅', '💼', '❤️', '👋'].map((ch) => <button key={ch} type="button" onMouseDown={(e) => { e.preventDefault(); insertEmoji(ch); }} style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer', padding: 4 }}>{ch}</button>)}</div>}
              </div>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem', color: 'var(--text-secondary)', cursor: 'pointer' }}><input type="checkbox" checked={trackEmail} onChange={(e) => setTrackEmail(e.target.checked)} /> Track this email</label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem', color: 'var(--text-secondary)', cursor: 'pointer' }}><input type="checkbox" checked={addUnsub} onChange={(e) => setAddUnsub(e.target.checked)} /> Add unsubscribe link</label>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              {draftNote && <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>{draftNote}</span>}
              <button type="button" className="cp-icon-btn" title="Delete draft" aria-label="Delete draft" onClick={deleteDraft}><Trash2 size={15} /></button>
              <div style={{ display: 'flex', position: 'relative' }}>
                <button type="button" className="cp-action-btn cp-action-primary" onClick={send} disabled={sending} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', borderRadius: '6px 0 0 6px' }}><Send size={13} /> {sending ? 'Sending…' : 'Send'}</button>
                <button type="button" className="cp-action-btn cp-action-primary" aria-label="More send options" onClick={() => setSendMenuOpen((v) => !v)} onBlur={(e) => { if (!e.currentTarget.parentElement.contains(e.relatedTarget)) setSendMenuOpen(false); }} style={{ borderRadius: '0 6px 6px 0', borderLeft: '1px solid rgba(255,255,255,0.4)', padding: '0.4rem 0.5rem' }}><ChevronDown size={13} /></button>
                {sendMenuOpen && <div style={{ position: 'absolute', bottom: 'calc(100% + 6px)', right: 0, zIndex: 40, background: '#fff', border: '1px solid var(--border-color)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', minWidth: 150, overflow: 'hidden' }}>
                  <button type="button" onMouseDown={(e) => { e.preventDefault(); setSendMenuOpen(false); saveDraft(false); }} style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'none', padding: '0.55rem 0.8rem', fontSize: '0.8rem', cursor: 'pointer' }}>Save draft</button>
                  <button type="button" onMouseDown={(e) => { e.preventDefault(); setSendMenuOpen(false); send(); }} style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'none', padding: '0.55rem 0.8rem', fontSize: '0.8rem', cursor: 'pointer' }}>Send now</button>
                </div>}
              </div>
            </div>
          </div>
        </footer>
      </aside>
    </div>
  ), document.body);
}

export function SmsModal({ contact, onClose, onDone }) {
  const notify = useNotify();
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setSending(true);
    try {
      await sendSms({ to: contact.phone, body, contactId: contact.id });
      notify.success('SMS sent.');
      onDone();
      onClose();
    } catch {
      notify.error('Failed to send SMS.');
    } finally {
      setSending(false);
    }
  };
  return (
    <Modal title={`SMS ${contact.name || ''}`} onClose={onClose}>
      <form onSubmit={submit} className="cp-form">
        <FormRow label="To"><input className="cp-input" value={contact.phone || ''} disabled /></FormRow>
        <FormRow label="Message"><textarea className="cp-textarea" required rows={4} maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Type your SMS…" /></FormRow>
        <div className="cp-btn-row">
          <button type="button" className="cp-action-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="cp-action-btn cp-action-primary" disabled={sending}>{sending ? 'Sending…' : 'Send SMS'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function WhatsappModal({ contact, onClose, onDone }) {
  const notify = useNotify();
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setSending(true);
    try {
      await sendWhatsapp({ to: contact.phone, body, contactId: contact.id });
      notify.success('WhatsApp message sent.');
      onDone();
      onClose();
    } catch {
      notify.error('Failed to send WhatsApp message.');
    } finally {
      setSending(false);
    }
  };
  return (
    <Modal title={`WhatsApp ${contact.name || ''}`} onClose={onClose}>
      <form onSubmit={submit} className="cp-form">
        <FormRow label="To"><input className="cp-input" value={contact.phone || ''} disabled /></FormRow>
        <FormRow label="Message"><textarea className="cp-textarea" required rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Type your message…" /></FormRow>
        <div className="cp-btn-row">
          <button type="button" className="cp-action-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="cp-action-btn cp-action-primary" disabled={sending}>{sending ? 'Sending…' : 'Send'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function CallModal({ contact, onClose, onDone }) {
  const notify = useNotify();
  const [notes, setNotes] = useState('');
  const [logging, setLogging] = useState(false);
  const logCall = async (e) => {
    e.preventDefault();
    setLogging(true);
    try {
      await postActivity(contact.id, { type: 'Call', description: notes.trim() ? `Call: ${notes.trim()}` : 'Call logged' });
      notify.success('Call logged.');
      onDone();
      onClose();
    } catch {
      notify.error('Failed to log call.');
    } finally {
      setLogging(false);
    }
  };
  return (
    <Modal title={`Call ${contact.name || ''}`} onClose={onClose}>
      <div className="cp-form">
        <div className="cp-call-number">{contact.phone || 'No phone number'}</div>
        {contact.phone && <a className="cp-action-btn cp-action-primary" href={`tel:${String(contact.phone).replace(/\s/g, '')}`}>Call now</a>}
        <form onSubmit={logCall} className="cp-form">
          <FormRow label="Call notes"><textarea className="cp-textarea" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Outcome of the call…" /></FormRow>
          <div className="cp-btn-row">
            <button type="button" className="cp-action-btn" onClick={onClose}>Close</button>
            <button type="submit" className="cp-action-btn cp-action-primary" disabled={logging}>{logging ? 'Saving…' : 'Log call'}</button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

export function TaskModal({ contact, onClose, onDone }) {
  const notify = useNotify();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [completed, setCompleted] = useState(false);
  const [taskType, setTaskType] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [time, setTime] = useState('');
  const [outcome, setOutcome] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim() || !dueDate || saving) return;
    setSaving(true);
    try {
      const type = taskType === 'Follow up' ? 'Follow Up' : taskType === 'Call reminder' ? 'Call' : undefined;
      const outcomeValue = {
        Interested: 'interested',
        'Left message': 'pending',
        'No response': 'no_show',
        'Not interested': 'not_interested',
        'Not able to reach': 'no_show',
      }[outcome];
      await createTask({
        title: title.trim(),
        notes: description.trim() || undefined,
        dueDate: `${dueDate}T${time || '00:00'}`,
        status: completed ? 'Completed' : 'Pending',
        type,
        outcome: outcomeValue,
        contactId: contact?.id,
      });
      notify.success('Task created.');
      onDone?.();
      onClose();
    } catch (error) {
      notify.error(error?.message || 'Failed to create task.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="cp-task-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Add task">
      <aside className="cp-task-drawer" onClick={(e) => e.stopPropagation()}>
        <header className="cp-task-head"><h3>Add task</h3><button type="button" className="cp-icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button></header>
        <form onSubmit={submit}>
        <div className="cp-task-body">
          <label className="cp-task-check"><input type="checkbox" checked={completed} onChange={(e) => setCompleted(e.target.checked)} /> Mark as completed</label>
          <div className="cp-task-columns">
            <div className="cp-task-main">
              <label className="cp-task-field"><span>Title <b>*</b></span><input className="cp-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Enter title of task" /></label>
              <label className="cp-task-field"><span>Description</span><textarea className="cp-textarea cp-task-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Start typing the details about the task..." /></label>
              <label className="cp-task-field"><span>Task type</span><select className="cp-input" value={taskType} onChange={(e) => setTaskType(e.target.value)}><option value="">Select a type</option><option>Follow up</option><option>Call reminder</option></select></label>
              <div className="cp-task-date-row">
                <label className="cp-task-field"><span>Due date <b>*</b></span><input className="cp-input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label>
                <label className="cp-task-field"><span>Time</span><input className="cp-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
              </div>
              <label className="cp-task-field"><span>Outcome</span><select className="cp-input" value={outcome} onChange={(e) => setOutcome(e.target.value)}><option value="">Select an outcome</option><option>Interested</option><option>Left message</option><option>No response</option><option>Not interested</option><option>Not able to reach</option></select></label>
            </div>
            <div className="cp-task-side">
              <label className="cp-task-field"><span>Owner</span><select className="cp-input" defaultValue=""><option value="">Select owner</option>{contact?.assignedTo?.name && <option value={contact.assignedTo.name}>{contact.assignedTo.name}</option>}</select></label>
              <label className="cp-task-field"><span>Related to (1)</span><select className="cp-input" defaultValue="contact"><option value="contact">Click to select records</option></select><span className="cp-task-chip">{contact?.name} <X size={12} /></span></label>
              <label className="cp-task-field"><span>Collaborators (0)</span><select className="cp-input" defaultValue=""><option value="">Select collaborators</option></select></label>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', padding: '0 1.5rem 1.25rem' }}>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={saving || !title.trim() || !dueDate}>{saving ? 'Saving…' : 'Add Task'}</button>
        </div>
        </form>
      </aside>
    </div>
  );
}

export function LegacyTaskModal({ contact, onClose, onDone }) {
  const notify = useNotify();
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState(todayPlus(1));
  const [priority, setPriority] = useState('Medium');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await createTask({ title: title.trim(), dueDate, priority, notes: notes.trim() || undefined, contactId: contact.id });
      notify.success('Task created.');
      onDone();
      onClose();
    } catch {
      notify.error('Failed to create task.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title={`New task for ${contact.name || ''}`} onClose={onClose}>
      <form onSubmit={submit} className="cp-form">
        <FormRow label="Title"><input className="cp-input" required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" /></FormRow>
        <FormRow label="Due date"><input className="cp-input" type="datetime-local" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></FormRow>
        <FormRow label="Priority">
          <select className="cp-input" value={priority} onChange={(e) => setPriority(e.target.value)}>
            {['Low', 'Medium', 'High', 'Urgent'].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </FormRow>
        <FormRow label="Notes"><textarea className="cp-textarea" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Details…" /></FormRow>
        <div className="cp-btn-row">
          <button type="button" className="cp-action-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="cp-action-btn cp-action-primary" disabled={saving}>{saving ? 'Saving…' : 'Create task'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function MeetingModal({ contact, onClose, onDone }) {
  const notify = useNotify();
  const [title, setTitle] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [fromTime, setFromTime] = useState('');
  const [toDate, setToDate] = useState('');
  const [toTime, setToTime] = useState('');
  const [allDay, setAllDay] = useState(false);
  const [timezone, setTimezone] = useState('(GMT +05:30) Chennai');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [outcome, setOutcome] = useState('');
  const [meetingNotes, setMeetingNotes] = useState('');
  const [showOutcome, setShowOutcome] = useState(false);
  const [showMeetingNotes, setShowMeetingNotes] = useState(false);
  const [saving, setSaving] = useState(false);
  const keyOf = (type, id) => `${type}:${id}`;
  const [relatedList, setRelatedList] = useState(() => (contact?.name ? [{ key: keyOf('contact', contact.id ?? contact.name), label: contact.name, type: 'contact' }] : []));
  const [attendeeList, setAttendeeList] = useState(() => (contact?.name ? [{ key: keyOf('contact', contact.id ?? contact.name), label: contact.name }] : []));
  const [allContacts, setAllContacts] = useState([]);
  const [allDeals, setAllDeals] = useState([]);
  const [relatedQuery, setRelatedQuery] = useState('');
  const [attendeeQuery, setAttendeeQuery] = useState('');
  const normList = (v) => (Array.isArray(v) ? v : Array.isArray(v?.data) ? v.data : []);
  const mergeById = (prev, next) => {
    const seen = new Set(prev.map((r) => String(r.id ?? r.name ?? r.title)));
    const out = [...prev];
    for (const r of next) {
      const k = String(r.id ?? r.name ?? r.title);
      if (!seen.has(k)) { seen.add(k); out.push(r); }
    }
    return out;
  };
  const loadAll = async (signal) => {
    try {
      const [c, d] = await Promise.all([
        fetchApi('/api/contacts?limit=500', { silent: true }).catch(() => []),
        fetchApi('/api/deals?limit=500', { silent: true }).catch(() => []),
      ]);
      if (signal?.aborted) return;
      const freshContacts = normList(c);
      const freshDeals = normList(d);
      if (freshContacts.length) setAllContacts((prev) => mergeById(freshContacts, prev.filter((p) => !freshContacts.some((n) => String(n.id) === String(p.id)))));
      if (freshDeals.length) setAllDeals(freshDeals);
    } catch {
      /* keep preselected current contact */
    }
  };
  useEffect(() => {
    const ctrl = new AbortController();
    loadAll(ctrl.signal);
    return () => ctrl.abort();
  }, []);
  useEffect(() => {
    const q = relatedQuery.trim();
    const q2 = attendeeQuery.trim();
    const term = q || q2;
    if (!term) return;
    const t = setTimeout(async () => {
      try {
        const c = await fetchApi(`/api/contacts?limit=50&q=${encodeURIComponent(term)}`, { silent: true }).catch(() => []);
        setAllContacts((prev) => mergeById(prev, normList(c)));
      } catch { /* ignore */ }
    }, 300);
    return () => clearTimeout(t);
  }, [relatedQuery, attendeeQuery]);
  const [relatedOpen, setRelatedOpen] = useState(false);
  const [attendeeOpen, setAttendeeOpen] = useState(false);
  const qLower = (s) => String(s || '').toLowerCase();
  const filterContactsBy = (list, term) => {
    const q = qLower(term.trim());
    if (!q) return list;
    return list.filter((c) => qLower(c.name).includes(q) || qLower(c.email).includes(q) || qLower(c.company).includes(q));
  };
  const relatedContacts = useMemo(() => filterContactsBy(allContacts, relatedQuery), [allContacts, relatedQuery]);
  const attendeeContacts = useMemo(() => filterContactsBy(allContacts, attendeeQuery), [allContacts, attendeeQuery]);
  const filteredDeals = useMemo(() => {
    const q = qLower(relatedQuery.trim());
    if (!q) return allDeals;
    return allDeals.filter((d) => qLower(d.title).includes(q));
  }, [allDeals, relatedQuery]);
  const accountOptions = useMemo(() => {
    const set = new Set();
    for (const c of allContacts) {
      const name = String(c.company || '').trim();
      if (name) set.add(name);
    }
    const q = relatedQuery.trim().toLowerCase();
    return [...set]
      .filter((n) => !q || n.toLowerCase().includes(q))
      .sort((a, b) => a.localeCompare(b)).slice(0, 100);
  }, [allContacts, relatedQuery]);
  const addRelated = (value) => {
    if (!value) return;
    const [type, ...rest] = String(value).split(':');
    const raw = rest.join(':');
    let label = raw;
    if (type === 'contact') {
      const found = allContacts.find((c) => String(c.id) === raw);
      label = found?.name || (contact?.name && String(contact.id ?? contact.name) === raw ? contact.name : raw);
    } else if (type === 'deal') {
      const found = allDeals.find((d) => String(d.id) === raw);
      label = found?.title || raw;
    }
    const key = `${type}:${raw}`;
    setRelatedList((prev) => (prev.some((r) => r.key === key) ? prev : [...prev, { key, label, type }]));
  };
  const addAttendee = (value) => {
    if (!value) return;
    const found = allContacts.find((c) => String(c.id) === String(value));
    const label = found?.name || (contact?.name && String(contact.id ?? contact.name) === String(value) ? contact.name : String(value));
    const key = `contact:${value}`;
    setAttendeeList((prev) => (prev.some((r) => r.key === key) ? prev : [...prev, { key, label }]));
  };
  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim() || !fromDate || saving) return;
    setSaving(true);
    try {
      const details = [
        description.trim(),
        outcome.trim() ? `Outcome: ${outcome.trim()}` : '',
        meetingNotes.trim() ? `Meeting notes: ${meetingNotes.trim()}` : '',
        location.trim() ? `Location: ${location.trim()}` : '',
      ].filter(Boolean).join('\n');
      const activity = await postActivity(contact.id, { type: 'Meeting', description: details || `Meeting: ${title.trim()}` });
      const start = new Date(`${fromDate}T${allDay ? '00:00' : (fromTime || '00:00')}`);
      const end = new Date(`${toDate || fromDate}T${allDay ? '00:00' : (toTime || fromTime || '00:00')}`);
      if (contact.email && !Number.isNaN(start.getTime())) {
        await syncMeetingToCalendar({ title: title.trim(), description: details, startTime: start.toISOString(), endTime: (Number.isNaN(end.getTime()) ? new Date(start.getTime() + 30 * 60000) : end).toISOString(), attendees: [contact.email], contactId: activity?.contactId || contact.id });
      }
      notify.success('Meeting saved.');
      onDone?.();
      onClose();
    } catch (error) {
      notify.error(error?.message || 'Failed to save meeting.');
    } finally {
      setSaving(false);
    }
  };
  return <div className="cp-meeting-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Add meeting">
    <aside className="cp-meeting-drawer" onClick={(e) => e.stopPropagation()}>
      <header className="cp-task-head"><h3>Add meeting</h3><button type="button" className="cp-icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button></header>
      <form onSubmit={submit}>
      <div className="cp-meeting-body"><div className="cp-meeting-columns"><div className="cp-task-main">
        <label className="cp-task-field"><span>Title <b>*</b></span><input className="cp-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Enter title of meeting" /></label>
        <div className="cp-task-date-row"><MeetingDateField label="From *" date={fromDate} setDate={setFromDate} time={fromTime} setTime={setFromTime} allDay={allDay} /><MeetingDateField label="To *" date={toDate} setDate={setToDate} time={toTime} setTime={setToTime} allDay={allDay} /></div>
        <label className="cp-task-check"><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> All day</label>
        <label className="cp-task-field"><span>Time zone</span><select className="cp-input" value={timezone} onChange={(e) => setTimezone(e.target.value)}><option>(GMT +05:30) Chennai</option><option>(GMT +00:00) London</option><option>(GMT -05:00) New York</option></select></label>
        <label className="cp-task-field"><span>Location</span><input className="cp-input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Enter location of meeting" /></label>
        <label className="cp-task-field"><span>Description</span><textarea className="cp-textarea cp-task-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Start typing the details about the meeting..." /></label>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          {!showOutcome && <button type="button" className="cp-link-btn" onClick={() => setShowOutcome(true)}><Plus size={13} /> Add outcome</button>}
          {!showMeetingNotes && <button type="button" className="cp-link-btn" onClick={() => setShowMeetingNotes(true)}><Plus size={13} /> Add meeting notes</button>}
        </div>
        {showOutcome && <label className="cp-task-field"><span>Outcome</span><input className="cp-input" value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="Enter meeting outcome" /></label>}
        {showMeetingNotes && <label className="cp-task-field"><span>Meeting notes</span><textarea className="cp-textarea" rows={4} value={meetingNotes} onChange={(e) => setMeetingNotes(e.target.value)} placeholder="Add meeting notes" /></label>}
      </div><div className="cp-task-side">
        <div className="cp-task-field"><span>Related to ({relatedList.length}) <span title="Records can be contacts, accounts or deals" style={{ display: 'inline-flex', verticalAlign: 'middle', cursor: 'help' }}><Info size={13} /></span></span><div style={{ position: 'relative' }} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setRelatedOpen(false); }}><button type="button" className="cp-input" style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--text-secondary)', cursor: 'pointer' }} onClick={() => { setRelatedOpen((v) => !v); loadAll(); }} aria-haspopup="listbox" aria-expanded={relatedOpen}><span>Click to select records</span><span aria-hidden="true">▾</span></button>{relatedOpen && <div role="listbox" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30, background: 'var(--surface, #fff)', border: '1px solid var(--border-color)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', overflow: 'hidden' }}><div style={{ padding: 6, borderBottom: '1px solid var(--border-color)' }}><input autoFocus className="cp-input" value={relatedQuery} onChange={(e) => setRelatedQuery(e.target.value)} placeholder="Search contacts, accounts or deals..." aria-label="Search related records" style={{ width: '100%' }} /></div><div style={{ maxHeight: 220, overflowY: 'auto', padding: 4 }}>{relatedContacts.slice(0, 100).map((c) => <button key={`c-${c.id}`} type="button" role="option" aria-selected="false" onClick={() => addRelated(`contact:${c.id}`)} style={{ display: 'flex', width: '100%', gap: 6, alignItems: 'center', padding: '6px 8px', border: 0, background: 'none', cursor: 'pointer', textAlign: 'left' }}><span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Contact ·</span> {c.name || `Contact #${c.id}`}</button>)}{accountOptions.map((name) => <button key={`a-${name}`} type="button" role="option" aria-selected="false" onClick={() => addRelated(`account:${name}`)} style={{ display: 'flex', width: '100%', gap: 6, alignItems: 'center', padding: '6px 8px', border: 0, background: 'none', cursor: 'pointer', textAlign: 'left' }}><span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Account ·</span> {name}</button>)}{filteredDeals.slice(0, 100).map((d) => <button key={`d-${d.id}`} type="button" role="option" aria-selected="false" onClick={() => addRelated(`deal:${d.id}`)} style={{ display: 'flex', width: '100%', gap: 6, alignItems: 'center', padding: '6px 8px', border: 0, background: 'none', cursor: 'pointer', textAlign: 'left' }}><span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Deal ·</span> {d.title || `Deal #${d.id}`}</button>)}{relatedContacts.length === 0 && accountOptions.length === 0 && filteredDeals.length === 0 && <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-secondary)' }}>No matches</div>}</div></div>}</div>{relatedList.map((r) => <span key={r.key} className="cp-task-chip"><span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: '50%', background: '#f3d1e0', color: '#7a2e4a', fontSize: 11, fontWeight: 700 }}>{String(r.label || '?').charAt(0).toUpperCase()}</span>{r.label} <button type="button" aria-label="Remove related record" onClick={() => setRelatedList((prev) => prev.filter((x) => x.key !== r.key))}><X size={12} /></button></span>)}</div>
        <div className="cp-task-field"><span>Attendees ({attendeeList.length})</span><div style={{ position: 'relative' }} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setAttendeeOpen(false); }}><button type="button" className="cp-input" style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--text-secondary)', cursor: 'pointer' }} onClick={() => { setAttendeeOpen((v) => !v); loadAll(); }} aria-haspopup="listbox" aria-expanded={attendeeOpen}><span>Click to select attendees</span><span aria-hidden="true">▾</span></button>{attendeeOpen && <div role="listbox" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30, background: 'var(--surface, #fff)', border: '1px solid var(--border-color)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', overflow: 'hidden' }}><div style={{ padding: 6, borderBottom: '1px solid var(--border-color)' }}><input autoFocus className="cp-input" value={attendeeQuery} onChange={(e) => setAttendeeQuery(e.target.value)} placeholder="Search attendees..." aria-label="Search attendees" style={{ width: '100%' }} /></div><div style={{ maxHeight: 220, overflowY: 'auto', padding: 4 }}>{attendeeContacts.slice(0, 100).map((c) => <button key={c.id} type="button" role="option" aria-selected="false" onClick={() => addAttendee(c.id)} style={{ display: 'flex', width: '100%', gap: 6, alignItems: 'center', padding: '6px 8px', border: 0, background: 'none', cursor: 'pointer', textAlign: 'left' }}>{c.name || c.email || `Contact #${c.id}`}</button>)}{attendeeContacts.length === 0 && <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-secondary)' }}>No matches</div>}</div></div>}</div><small className="cp-meeting-info"><Info size={13} /> Attendees will get an email invitation</small>{attendeeList.map((a) => <span key={a.key} className="cp-task-chip"><span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: '50%', background: '#e5e7eb', color: '#374151', fontSize: 11, fontWeight: 700 }}>{String(a.label || '?').charAt(0).toUpperCase()}</span>{a.label} <button type="button" aria-label="Remove attendee" onClick={() => setAttendeeList((prev) => prev.filter((x) => x.key !== a.key))}><X size={12} /></button></span>)}</div>
      </div></div></div>
      <footer className="cp-meeting-footer"><div /><div><button type="button" className="cp-action-btn" onClick={onClose} disabled={saving}>Cancel</button><button type="submit" className="cp-action-btn cp-action-primary" disabled={saving || !title.trim() || !fromDate}>{saving ? 'Saving…' : 'Save'}</button></div></footer>
      </form>
    </aside></div>;
}

function MeetingDateField({ label, date, setDate, time, setTime, allDay }) {
  return <div className="cp-task-field"><span>{label}</span><span className="cp-task-date-stack"><input className="cp-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />{!allDay && <input className="cp-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />}</span></div>;
}

export function LegacyMeetingModal({ contact, onClose, onDone }) {
  const notify = useNotify();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [time, setTime] = useState('10:00');
  const [agenda, setAgenda] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    const start = new Date(`${date}T${time}`);
    if (Number.isNaN(start.getTime())) {
      notify.error('Choose a valid date and time.');
      return;
    }
    if (start < new Date()) {
      notify.error('Meeting start time must be now or in the future.');
      return;
    }
    setSaving(true);
    try {
      const description = `Meeting on ${date} at ${time}${agenda.trim() ? ` — ${agenda.trim()}` : ''}`;
      const activity = await postActivity(contact.id, { type: 'Meeting', description });
      const end = new Date(start.getTime() + 30 * 60000);
      if (contact.email) {
        await syncMeetingToCalendar({
          title: `Meeting with ${contact.name}`,
          description,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          attendees: [contact.email],
          contactId: activity?.contactId || contact.id,
        });
      }
      notify.success('Meeting scheduled.');
      onDone();
      onClose();
    } catch {
      notify.error('Failed to schedule meeting.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title={`Schedule meeting with ${contact.name || ''}`} onClose={onClose}>
      <form onSubmit={submit} className="cp-form">
        <FormRow label="Date"><input className="cp-input" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></FormRow>
        <FormRow label="Time"><input className="cp-input" type="time" required value={time} onChange={(e) => setTime(e.target.value)} /></FormRow>
        <FormRow label="Agenda"><textarea className="cp-textarea" rows={3} value={agenda} onChange={(e) => setAgenda(e.target.value)} placeholder="What is this meeting about?" /></FormRow>
        <div className="cp-btn-row">
          <button type="button" className="cp-action-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="cp-action-btn cp-action-primary" disabled={saving}>{saving ? 'Saving…' : 'Schedule'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function ActivityModal({ contact, presetType, onClose, onDone }) {
  const notify = useNotify();
  const [type, setType] = useState(presetType || 'Note');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await postActivity(contact.id, { type, description: description.trim() });
      notify.success('Activity logged.');
      onDone();
      onClose();
    } catch {
      notify.error('Failed to log activity.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title="Log activity" onClose={onClose}>
      <form onSubmit={submit} className="cp-form">
        <FormRow label="Type">
          <select className="cp-input" value={type} onChange={(e) => setType(e.target.value)}>
            {ACTIVITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </FormRow>
        <FormRow label="Details"><textarea className="cp-textarea" required rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe the activity…" /></FormRow>
        <div className="cp-btn-row">
          <button type="button" className="cp-action-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="cp-action-btn cp-action-primary" disabled={saving}>{saving ? 'Saving…' : 'Log activity'}</button>
        </div>
      </form>
    </Modal>
  );
}

const DEAL_TYPES = ['New Business', 'Existing Business', 'Renewal', 'Upsell', 'Cross-sell'];

const CURRENCY_OPTIONS = ['USD', 'INR', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD'];

const slugifyStage = (name) => String(name || '')
  .toLowerCase()
  .trim()
  .replace(/\s+/g, '-')
  .replace(/[^a-z0-9-]/g, '');

const asList = (d) => {
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.data)) return d.data;
  if (Array.isArray(d?.staff)) return d.staff;
  if (Array.isArray(d?.users)) return d.users;
  return [];
};

export function DealModal({ contact, deal, onClose, onDone }) {
  const notify = useNotify();
  const editing = Boolean(deal?.id);
  const initialContact = deal?.contact || contact;
  const [contactId, setContactId] = useState(deal?.contactId ?? initialContact?.id ?? null);
  const [contactName, setContactName] = useState(initialContact?.name || '');
  const [contactQuery, setContactQuery] = useState('');
  const [contactFocused, setContactFocused] = useState(false);
  const [account, setAccount] = useState(initialContact?.company || '');
  const [accountTouched, setAccountTouched] = useState(false);
  const [dealType, setDealType] = useState('');
  const [title, setTitle] = useState(deal?.title || (initialContact?.name ? `${initialContact.name} Deal` : ''));
  const [titleTouched, setTitleTouched] = useState(Boolean(deal?.title));
  const [currency, setCurrency] = useState(deal?.currency || tenantCurrency());
  const [amount, setAmount] = useState(deal?.amount ?? '');
  const [productsOpen, setProductsOpen] = useState(false);
  const [products, setProducts] = useState([]);
  const [stage, setStage] = useState(deal?.stage || '');
  const [pipelineId, setPipelineId] = useState(deal?.pipelineId ? String(deal.pipelineId) : '');
  const [probability, setProbability] = useState(deal?.probability ?? 50);
  const [expectedClose, setExpectedClose] = useState(deal?.expectedClose ? String(deal.expectedClose).slice(0, 10) : '');
  const [ownerId, setOwnerId] = useState(initialContact?.assignedToId ? String(initialContact.assignedToId) : '');
  const [showAll, setShowAll] = useState(false);
  const [contacts, setContacts] = useState([]);
  const [stages, setStages] = useState([]);
  const [pipelines, setPipelines] = useState([]);
  const [staff, setStaff] = useState([]);
  const [listsLoading, setListsLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [c, s, p, u] = await Promise.all([
          fetchApi('/api/contacts?limit=200', { silent: true }).catch(() => []),
          fetchApi('/api/pipeline_stages', { silent: true }).catch(() => []),
          fetchApi('/api/pipelines?fields=summary', { silent: true }).catch(() => []),
          fetchApi('/api/staff?fields=summary', { silent: true }).catch(() => []),
        ]);
        if (!alive) return;
        setContacts(asList(c));
        setStages(asList(s));
        setPipelines(asList(p));
        setStaff(asList(u));
      } finally {
        if (alive) setListsLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const stageOptions = useMemo(() => {
    const fromApi = stages
      .map((s) => ({ value: slugifyStage(s.name), label: s.name }))
      .filter((o) => o.value);
    const base = fromApi.length > 0 ? fromApi : DEAL_STAGES.map((s) => ({ value: s, label: s }));
    if (deal?.stage && !base.some((o) => o.value === deal.stage)) {
      return [...base, { value: deal.stage, label: deal.stage }];
    }
    return base;
  }, [stages, deal?.stage]);

  useEffect(() => {
    if (!stage && stageOptions.length > 0) {
      setStage(stageOptions.some((o) => o.value === 'lead') ? 'lead' : stageOptions[0].value);
    }
  }, [stage, stageOptions]);

  const companyOptions = useMemo(() => {
    const set = new Set();
    for (const c of contacts) {
      const name = String(c.company || '').trim();
      if (name) set.add(name);
    }
    if (accountTouched && account.trim()) set.add(account.trim());
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [contacts, account, accountTouched]);

  const contactResults = useMemo(() => {
    const q = contactQuery.trim().toLowerCase();
    return contacts
      .filter((c) => String(c.id) !== String(contactId))
      .filter((c) => !q
        || String(c.name || '').toLowerCase().includes(q)
        || String(c.email || '').toLowerCase().includes(q)
        || String(c.company || '').toLowerCase().includes(q))
      .slice(0, 8);
  }, [contacts, contactQuery, contactId]);

  const currencyOptions = useMemo(() => {
    const tenant = tenantCurrency();
    return [tenant, ...CURRENCY_OPTIONS.filter((c) => c !== tenant)];
  }, []);

  const pickContact = (c) => {
    setContactId(c.id);
    setContactName(c.name || '');
    setContactQuery('');
    setContactFocused(false);
    if (!accountTouched) setAccount(c.company || '');
    if (!titleTouched && c.name) setTitle(`${c.name} Deal`);
  };

  const clearContact = () => {
    setContactId(null);
    setContactName('');
    setContactQuery('');
    setContactFocused(true);
  };

  const updateProducts = (next) => {
    setProducts(next);
    const total = next.reduce((sum, r) => {
      const q = Number(r.qty);
      const pr = Number(r.price);
      if (!Number.isFinite(q) || !Number.isFinite(pr)) return sum;
      return sum + q * pr;
    }, 0);
    if (next.length > 0) setAmount(total ? Number(total.toFixed(2)) : '');
  };

  const productsTotal = useMemo(() => products.reduce((sum, r) => {
    const q = Number(r.qty);
    const pr = Number(r.price);
    if (!Number.isFinite(q) || !Number.isFinite(pr)) return sum;
    return sum + q * pr;
  }, 0), [products]);

  const submit = async (e) => {
    e.preventDefault();
    const name = title.trim();
    if (!name) {
      notify.error('Enter a deal name.');
      return;
    }
    if (amount === '' || !Number.isFinite(Number(amount)) || Number(amount) < 0) {
      notify.error('Enter a deal value of 0 or more.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        title: name,
        amount: Number(amount),
        stage: stage || 'lead',
        probability: Number(probability) || 50,
        currency,
      };
      if (contactId) payload.contactId = contactId;
      if (pipelineId) payload.pipelineId = Number(pipelineId);
      if (expectedClose) payload.expectedClose = expectedClose;
      if (editing) {
        await updateDeal(deal.id, payload);
        notify.success('Deal updated.');
      } else {
        await createDeal(payload);
        notify.success('Deal created.');
      }
      onDone();
      onClose();
    } catch {
      notify.error(editing ? 'Failed to update deal.' : 'Failed to create deal.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cp-deal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={editing ? 'Edit deal' : 'Add deal'}>
      <aside className="cp-deal-drawer" onClick={(e) => e.stopPropagation()}>
        <header className="cp-task-head">
          <h3>{editing ? 'Edit deal' : 'Add deal'}</h3>
          <span className="cp-deal-head-actions">
            <button type="button" className="cp-icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
          </span>
        </header>
        <form onSubmit={submit}>
          <div className="cp-deal-body">
            <div className="cp-deal-field">
              <span>Related contact</span>
              {contactId ? (
                <span className="cp-deal-chip">
                  <span className="cp-deal-avatar">{(contactName || '?').charAt(0).toUpperCase()}</span>
                  {contactName || `Contact #${contactId}`}
                  <button type="button" aria-label="Remove related contact" onClick={clearContact}><X size={12} /></button>
                </span>
              ) : (
                <>
                  <input
                    className="cp-input"
                    value={contactQuery}
                    onChange={(e) => { setContactQuery(e.target.value); setContactFocused(true); }}
                    onFocus={() => setContactFocused(true)}
                    onBlur={() => setTimeout(() => setContactFocused(false), 120)}
                    placeholder={listsLoading ? 'Loading contacts…' : 'Search contacts by name, email or company'}
                    aria-label="Search related contact"
                  />
                  {contactFocused && contactResults.length > 0 && (
                    <div className="cp-deal-results" role="listbox">
                      {contactResults.map((c) => (
                        <button key={c.id} type="button" role="option" aria-selected="false" onMouseDown={(ev) => ev.preventDefault()} onClick={() => pickContact(c)}>
                          <span className="cp-deal-avatar">{String(c.name || '?').charAt(0).toUpperCase()}</span>
                          <span className="cp-deal-result-main">{c.name || `Contact #${c.id}`}</span>
                          {c.company && <span className="cp-deal-result-sub">{c.company}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
            <label className="cp-deal-field">
              <span>Related account</span>
              <select
                className="cp-input"
                value={account}
                onChange={(e) => { setAccount(e.target.value); setAccountTouched(true); }}
              >
                <option value="">Click to select</option>
                {companyOptions.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <label className="cp-deal-field">
              <span>Deal type</span>
              <select className="cp-input" value={dealType} onChange={(e) => setDealType(e.target.value)}>
                <option value="">Click to select</option>
                {DEAL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="cp-deal-field">
              <span>Deal name <b>*</b></span>
              <input
                className="cp-input"
                value={title}
                onChange={(e) => { setTitle(e.target.value); setTitleTouched(true); }}
                placeholder="Deal name"
                aria-label="Deal name"
              />
            </label>
            <div className="cp-deal-field">
              <span className="cp-deal-split-label"><span>Currency</span><span>Deal value <b>*</b></span></span>
              <span className="cp-deal-split">
                <select className="cp-input" value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency">
                  {currencyOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <input
                  className="cp-input"
                  type="number"
                  min="0"
                  step="any"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="Enter value"
                  aria-label="Deal value"
                />
              </span>
            </div>
            <div className="cp-deal-field">
                {productsOpen ? (
                  <div className="cp-deal-products">
                    <span className="cp-deal-products-head">Products{productsTotal > 0 && <span> · Total {productsTotal.toLocaleString()} {currency}</span>}</span>
                    {products.map((r, i) => (
                      <span key={i} className="cp-deal-prod-row">
                        <input
                          className="cp-input"
                          value={r.name}
                          onChange={(e) => updateProducts(products.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)))}
                          placeholder="Product name"
                          aria-label={`Product ${i + 1} name`}
                        />
                        <input
                          className="cp-input"
                          type="number"
                          min="0"
                          step="any"
                          value={r.qty}
                          onChange={(e) => updateProducts(products.map((p, j) => (j === i ? { ...p, qty: e.target.value } : p)))}
                          placeholder="Qty"
                          aria-label={`Product ${i + 1} quantity`}
                        />
                        <input
                          className="cp-input"
                          type="number"
                          min="0"
                          step="any"
                          value={r.price}
                          onChange={(e) => updateProducts(products.map((p, j) => (j === i ? { ...p, price: e.target.value } : p)))}
                          placeholder="Price"
                          aria-label={`Product ${i + 1} price`}
                        />
                        <button
                          type="button"
                          className="cp-icon-btn"
                          aria-label={`Remove product ${i + 1}`}
                          onClick={() => updateProducts(products.filter((_, j) => j !== i))}
                        >
                          <X size={14} />
                        </button>
                      </span>
                    ))}
                    <span className="cp-deal-prod-actions">
                      <button type="button" className="cp-link-btn" onClick={() => updateProducts([...products, { name: '', qty: 1, price: '' }])}>
                        <Plus size={12} /> Add product
                      </button>
                      {products.length > 0 && (
                        <button type="button" className="cp-link-btn" onClick={() => { setProducts([]); setProductsOpen(false); }}>
                          Done
                        </button>
                      )}
                    </span>
                  </div>
                ) : (
                  <button type="button" className="cp-deal-products-toggle" onClick={() => setProductsOpen(true)}>
                    <PackagePlus size={13} /> Add products
                    {productsTotal > 0 && <span> · {productsTotal.toLocaleString()} {currency}</span>}
                  </button>
                )}
              </div>
            <label className="cp-deal-field">
              <span>Deal stage</span>
              <select className="cp-input" value={stage} onChange={(e) => setStage(e.target.value)}>
                <option value="">Click to select</option>
                {stageOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            {showAll && (
              <label className="cp-deal-field">
                <span>Probability %</span>
                <input className="cp-input" type="number" min="0" max="100" value={probability} onChange={(e) => setProbability(e.target.value)} />
              </label>
            )}
            {showAll && (
              <label className="cp-deal-field">
                <span>Pipeline</span>
                <select className="cp-input" value={pipelineId} onChange={(e) => setPipelineId(e.target.value)}>
                  <option value="">Click to select</option>
                  {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            )}
            {showAll && (
              <label className="cp-deal-field">
                <span>Expected close</span>
                <input className="cp-input" type="date" value={expectedClose} onChange={(e) => setExpectedClose(e.target.value)} />
              </label>
            )}
            {showAll && (
              <label className="cp-deal-field">
                <span>Owner</span>
                <select className="cp-input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                  <option value="">Click to select</option>
                  {staff.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
                </select>
              </label>
            )}
          </div>
          <footer className="cp-deal-footer">
            <button type="button" className="cp-action-btn" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
              <span aria-hidden="true">{'</>'}</span> {showAll ? 'Hide extra fields' : 'Show all fields'}
            </button>
            <span className="cf-footer-btns">
              <button type="button" className="cp-action-btn" onClick={onClose}>Cancel</button>
              <button type="submit" className="cf-save" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            </span>
          </footer>
        </form>
      </aside>
    </div>
  );
}
