import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Bold, Italic, Underline, Strikethrough, List, ListOrdered,
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
  Indent, Outdent, Link2, RemoveFormatting, Paperclip, X, Send, Save, Trash2, Copy,
} from "lucide-react";
import { AuthContext } from "../appContexts";
import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";

const DRAFT_KEY = "email-compose-draft-v1";
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_MIMES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "application/pdf", "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv", "text/plain", "application/zip",
]);

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizeUrl(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  const withProto = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withProto);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return withProto;
  } catch {
    return "";
  }
}

function RecipientInput({ id, label, recipients, onChange, placeholder }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const commit = (raw) => {
    const parts = String(raw).split(/[,\n;]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const next = [...recipients];
    let firstBad = "";
    for (const p of parts) {
      if (!EMAIL_RE.test(p)) { firstBad = p; continue; }
      if (!next.some((r) => r.toLowerCase() === p.toLowerCase())) next.push(p);
    }
    if (firstBad) setError(`"${firstBad}" is not a valid email address.`);
    else setError("");
    onChange(next);
    setText("");
  };
  return (
    <div>
      <label htmlFor={id} style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.85rem", color: "var(--text-secondary)", fontWeight: 600 }}>{label}</label>
      <div className="input-field" style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", alignItems: "center", padding: "0.45rem 0.6rem", minHeight: "2.6rem", cursor: "text" }} onClick={(e) => { const el = document.getElementById(id); if (el && e.target !== el) el.focus(); }}>
        {recipients.map((r) => (
          <span key={r} style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", padding: "0.2rem 0.35rem 0.2rem 0.6rem", background: "var(--subtle-bg-2)", border: "1px solid var(--border-color)", borderRadius: "999px", fontSize: "0.8rem", maxWidth: "100%" }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "220px" }}>{r}</span>
            <button type="button" aria-label={`Remove ${r}`} onClick={() => onChange(recipients.filter((x) => x !== r))} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-secondary)", display: "inline-flex", padding: 0 }}>
              <X size={13} />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            if (v.includes(",") || v.includes(";") || v.includes("\n")) commit(v);
            else setText(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); commit(text); }
            else if (e.key === "Backspace" && !text && recipients.length > 0) onChange(recipients.slice(0, -1));
          }}
          onBlur={() => { if (text.trim()) commit(text); }}
          placeholder={recipients.length === 0 ? placeholder : ""}
          autoComplete="off"
          style={{ flex: 1, minWidth: "160px", border: "none", outline: "none", background: "transparent", color: "var(--text-primary)", fontSize: "0.9rem" }}
        />
      </div>
      {error && <p role="alert" style={{ margin: "0.3rem 0 0", fontSize: "0.78rem", color: "var(--danger, #dc2626)" }}>{error}</p>}
    </div>
  );
}

function ToolbarButton({ title, onRun, children, shortcut }) {
  return (
    <button
      type="button"
      title={shortcut ? `${title} (${shortcut})` : title}
      aria-label={title}
      onMouseDown={(e) => { e.preventDefault(); onRun(); }}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: "2rem", height: "2rem", padding: "0 0.4rem", background: "transparent", border: "1px solid transparent", borderRadius: "6px", cursor: "pointer", color: "var(--text-primary)" }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--subtle-bg-2)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
    >
      {children}
    </button>
  );
}

export default function EmailCompose() {
  const { user } = useContext(AuthContext);
  const notify = useNotify();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [to, setTo] = useState([]);
  const [cc, setCc] = useState([]);
  const [bcc, setBcc] = useState([]);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState("");
  const [subjectError, setSubjectError] = useState("");
  const [toError, setToError] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [draftAt, setDraftAt] = useState("");
  const [restored, setRestored] = useState(false);
  const editorRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    const prefill = String(searchParams.get("to") || "").trim();
    if (prefill && EMAIL_RE.test(prefill)) {
      setTo([prefill]);
      setRestored(true);
      return;
    }
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (Array.isArray(d.to)) setTo(d.to.filter((x) => EMAIL_RE.test(x)));
        if (Array.isArray(d.cc) && d.cc.length > 0) { setCc(d.cc.filter((x) => EMAIL_RE.test(x))); setShowCc(true); }
        if (Array.isArray(d.bcc) && d.bcc.length > 0) { setBcc(d.bcc.filter((x) => EMAIL_RE.test(x))); setShowBcc(true); }
        if (typeof d.subject === "string") setSubject(d.subject);
        if (typeof d.bodyHtml === "string" && d.bodyHtml) {
          setBodyHtml(d.bodyHtml);
          if (editorRef.current) editorRef.current.innerHTML = d.bodyHtml;
        }
        if (d.savedAt) setDraftAt(new Date(d.savedAt).toLocaleTimeString());
      }
    } catch { /* no usable draft */ }
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    const hasContent = to.length > 0 || cc.length > 0 || bcc.length > 0 || subject.trim() || (editorRef.current?.innerText.trim());
    if (!hasContent) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ to, cc, bcc, subject, bodyHtml, savedAt: new Date().toISOString() }));
        setDraftAt(new Date().toLocaleTimeString());
      } catch { /* storage full — skip */ }
    }, 2000);
    return () => clearTimeout(t);
  }, [to, cc, bcc, subject, bodyHtml, restored]);

  const exec = useCallback((cmd, value = null) => {
    editorRef.current?.focus();
    try { document.execCommand(cmd, false, value); } catch { /* unsupported — ignore */ }
    if (editorRef.current) setBodyHtml(editorRef.current.innerHTML);
  }, []);

  const insertLink = useCallback(async () => {
    const sel = window.getSelection();
    const selected = sel && !sel.isCollapsed ? String(sel.toString()).trim() : "";
    const urlRaw = await notify.prompt("Link URL", "https://");
    if (urlRaw === null || urlRaw === undefined) return;
    const url = normalizeUrl(urlRaw);
    if (!url) { notify.error("Please enter a valid http(s) URL."); return; }
    editorRef.current?.focus();
    if (selected) {
      try { document.execCommand("createLink", false, url); } catch { /* ignore */ }
    } else {
      const text = await notify.prompt("Link text", url);
      if (text === null || text === undefined) return;
      const label = String(text).trim() || url;
      try { document.execCommand("insertHTML", false, `<a href="${url}" target="_blank" rel="noopener noreferrer">${label.replace(/</g, "&lt;")}</a>`); } catch { /* ignore */ }
    }
    if (editorRef.current) setBodyHtml(editorRef.current.innerHTML);
  }, [notify]);

  const addFiles = useCallback((files) => {
    const list = Array.from(files || []);
    if (list.length === 0) return;
    setAttachments((prev) => {
      const slotsLeft = MAX_ATTACHMENTS - prev.length;
      if (slotsLeft <= 0) { notify.error(`You can attach up to ${MAX_ATTACHMENTS} files.`); return prev; }
      const accepted = [];
      let skippedLarge = 0;
      let skippedType = 0;
      for (const f of list) {
        if (accepted.length >= slotsLeft) break;
        if (f.size > MAX_ATTACHMENT_BYTES) { skippedLarge += 1; continue; }
        if (f.type && !ALLOWED_MIMES.has(f.type)) {
          const okExt = /\.(pdf|doc|docx|xls|xlsx|csv|txt|zip|jpe?g|png|gif|webp)$/i.test(f.name);
          if (!okExt) { skippedType += 1; continue; }
        }
        accepted.push(f);
      }
      if (skippedLarge > 0) notify.error(`Some files were skipped — max ${formatSize(MAX_ATTACHMENT_BYTES)} per file.`);
      if (skippedType > 0) notify.error("Some files were skipped — file type not allowed (PDF, Word, Excel, CSV, TXT, ZIP, images).");
      return [...prev, ...accepted].slice(0, MAX_ATTACHMENTS);
    });
  }, [notify]);

  const validate = () => {
    let ok = true;
    if (to.length === 0) { setToError("Add at least one recipient."); ok = false; }
    else if (!to.every((r) => EMAIL_RE.test(r))) { setToError("One or more To addresses are invalid."); ok = false; }
    else setToError("");
    if (!subject.trim()) { setSubjectError("Subject is required."); ok = false; }
    else setSubjectError("");
    const bodyText = editorRef.current?.innerText.trim() || "";
    if (!bodyText) { notify.error("Email body is empty."); ok = false; }
    return ok;
  };

  const handleSend = async (e) => {
    if (e) e.preventDefault();
    if (sending) return;
    if (!validate()) return;
    setSending(true);
    try {
      const body = editorRef.current?.innerHTML || bodyHtml;
      let payload;
      if (attachments.length > 0) {
        const fd = new FormData();
        fd.append("to", to.join(", "));
        if (cc.length > 0) fd.append("cc", cc.join(", "));
        if (bcc.length > 0) fd.append("bcc", bcc.join(", "));
        fd.append("subject", subject.trim());
        fd.append("body", body);
        for (const f of attachments) fd.append("attachments", f, f.name);
        payload = fd;
      } else {
        payload = JSON.stringify({ to: to.join(", "), cc: cc.join(", "), bcc: bcc.join(", "), subject: subject.trim(), body });
      }
      await fetchApi("/api/communications/send-email", { method: "POST", body: payload });
      notify.success("Email sent successfully.");
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      navigate("/inbox");
    } catch (err) {
      notify.error(err?.message || "Failed to send email. Please try again.");
    } finally {
      setSending(false);
    }
  };

  const handleSaveDraft = () => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ to, cc, bcc, subject, bodyHtml: editorRef.current?.innerHTML || bodyHtml, savedAt: new Date().toISOString() }));
      setDraftAt(new Date().toLocaleTimeString());
      notify.success("Draft saved.");
    } catch {
      notify.error("Could not save draft.");
    }
  };

  const hasContent = to.length > 0 || cc.length > 0 || bcc.length > 0 || subject.trim() || (editorRef.current?.innerText.trim()) || attachments.length > 0;

  const handleDiscard = async () => {
    if (hasContent) {
      const yes = await notify.confirm("Discard this email? Your changes will be removed.", { title: "Discard email", confirmText: "Discard", danger: true });
      if (!yes) return;
    }
    setTo([]); setCc([]); setBcc([]); setSubject(""); setAttachments([]);
    if (editorRef.current) editorRef.current.innerHTML = "";
    setBodyHtml("");
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    navigate(-1);
  };

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === "Enter") { e.preventDefault(); handleSend(); }
      else if (mod && (e.key === "k" || e.key === "K")) { e.preventDefault(); insertLink(); }
      else if (e.key === "Escape") { navigate(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const fromEmail = user?.email || "";

  return (
    <div style={{ maxWidth: "960px", margin: "0 auto", padding: "1rem", width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", marginBottom: "1rem" }}>
        <h2 style={{ margin: 0, fontSize: "1.35rem", fontWeight: 700 }}>New message</h2>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          {draftAt && <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>Draft saved {draftAt}</span>}
          <button type="button" onClick={handleSaveDraft} style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", padding: "0.5rem 0.8rem", borderRadius: "8px", border: "1px solid var(--border-color)", background: "transparent", color: "var(--text-primary)", cursor: "pointer", fontSize: "0.85rem" }}>
            <Save size={14} /> Save draft
          </button>
          <button type="button" onClick={handleDiscard} style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", padding: "0.5rem 0.8rem", borderRadius: "8px", border: "1px solid var(--border-color)", background: "transparent", color: "var(--text-secondary)", cursor: "pointer", fontSize: "0.85rem" }}>
            <Trash2 size={14} /> Discard
          </button>
          <button type="button" onClick={handleSend} disabled={sending} style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", padding: "0.5rem 1.1rem", borderRadius: "8px", border: "none", background: "var(--accent-color)", color: "#fff", cursor: sending ? "not-allowed" : "pointer", opacity: sending ? 0.7 : 1, fontSize: "0.85rem", fontWeight: 700 }}>
            <Send size={14} /> {sending ? "Sending..." : "Send"}
          </button>
        </div>
      </div>

      <form
        onSubmit={handleSend}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); }}
        style={{ display: "flex", flexDirection: "column", gap: "0.9rem", background: "var(--modal-bg)", border: `1px solid ${dragging ? "var(--accent-color)" : "var(--border-color)"}`, borderRadius: "14px", padding: "1.1rem", boxShadow: "var(--glass-shadow)" }}
      >
        {dragging && <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--accent-color)", fontWeight: 600 }}>Drop files to attach them</p>}

        <div>
          <span style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.85rem", color: "var(--text-secondary)", fontWeight: 600 }}>From</span>
          <div className="input-field" style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>{fromEmail || "Your account email"}</div>
        </div>

        <RecipientInput id="compose-to" label="To" recipients={to} onChange={(v) => { setTo(v); if (v.length > 0) setToError(""); }} placeholder="Type an email and press Enter or comma" />
        {toError && <p role="alert" style={{ margin: "-0.4rem 0 0", fontSize: "0.78rem", color: "var(--danger, #dc2626)" }}>{toError}</p>}

        <div style={{ display: "flex", gap: "0.5rem" }}>
          {!showCc && <button type="button" onClick={() => setShowCc(true)} style={{ background: "transparent", border: "none", color: "var(--accent-color)", cursor: "pointer", fontSize: "0.85rem", fontWeight: 600, padding: 0, display: "inline-flex", alignItems: "center", gap: "0.25rem" }}><Copy size={13} /> Cc</button>}
          {!showBcc && <button type="button" onClick={() => setShowBcc(true)} style={{ background: "transparent", border: "none", color: "var(--accent-color)", cursor: "pointer", fontSize: "0.85rem", fontWeight: 600, padding: 0 }}>Bcc</button>}
        </div>
        {showCc && <RecipientInput id="compose-cc" label="Cc" recipients={cc} onChange={setCc} placeholder="Cc recipients" />}
        {showBcc && <RecipientInput id="compose-bcc" label="Bcc" recipients={bcc} onChange={setBcc} placeholder="Bcc recipients" />}

        <div>
          <label htmlFor="compose-subject" style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.85rem", color: "var(--text-secondary)", fontWeight: 600 }}>Subject</label>
          <input id="compose-subject" className="input-field" value={subject} onChange={(e) => { setSubject(e.target.value); if (e.target.value.trim()) setSubjectError(""); }} placeholder="Subject" style={{ width: "100%" }} />
          {subjectError && <p role="alert" style={{ margin: "0.3rem 0 0", fontSize: "0.78rem", color: "var(--danger, #dc2626)" }}>{subjectError}</p>}
        </div>

        <div>
          <span style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.85rem", color: "var(--text-secondary)", fontWeight: 600 }}>Body</span>
          <div role="toolbar" aria-label="Email formatting" style={{ display: "flex", flexWrap: "wrap", gap: "0.15rem", alignItems: "center", padding: "0.35rem", border: "1px solid var(--border-color)", borderBottom: "none", borderRadius: "10px 10px 0 0", background: "var(--subtle-bg-2)" }}>
            <ToolbarButton title="Bold" onRun={() => exec("bold")}><Bold size={15} /></ToolbarButton>
            <ToolbarButton title="Italic" onRun={() => exec("italic")}><Italic size={15} /></ToolbarButton>
            <ToolbarButton title="Underline" onRun={() => exec("underline")}><Underline size={15} /></ToolbarButton>
            <ToolbarButton title="Strikethrough" onRun={() => exec("strikeThrough")}><Strikethrough size={15} /></ToolbarButton>
            <select aria-label="Font size" defaultValue="" onChange={(e) => { if (e.target.value) exec("fontSize", e.target.value); e.target.value = ""; }} style={{ height: "2rem", borderRadius: "6px", border: "1px solid var(--border-color)", background: "transparent", color: "var(--text-primary)", fontSize: "0.8rem" }}>
              <option value="">Size</option>
              {[1, 2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <label title="Text color" style={{ display: "inline-flex", alignItems: "center", gap: "0.2rem", fontSize: "0.75rem", padding: "0 0.3rem", cursor: "pointer" }}>
              <span style={{ fontWeight: 700 }}>A</span>
              <input type="color" aria-label="Text color" onChange={(e) => exec("foreColor", e.target.value)} style={{ width: "1.6rem", height: "1.6rem", border: "none", background: "none", cursor: "pointer", padding: 0 }} />
            </label>
            <label title="Highlight color" style={{ display: "inline-flex", alignItems: "center", gap: "0.2rem", fontSize: "0.75rem", padding: "0 0.3rem", cursor: "pointer" }}>
              <span style={{ fontWeight: 700, background: "#fef08a", borderRadius: "3px", padding: "0 3px" }}>A</span>
              <input type="color" aria-label="Highlight color" defaultValue="#fef08a" onChange={(e) => exec("hiliteColor", e.target.value)} style={{ width: "1.6rem", height: "1.6rem", border: "none", background: "none", cursor: "pointer", padding: 0 }} />
            </label>
            <ToolbarButton title="Align left" onRun={() => exec("justifyLeft")}><AlignLeft size={15} /></ToolbarButton>
            <ToolbarButton title="Align center" onRun={() => exec("justifyCenter")}><AlignCenter size={15} /></ToolbarButton>
            <ToolbarButton title="Align right" onRun={() => exec("justifyRight")}><AlignRight size={15} /></ToolbarButton>
            <ToolbarButton title="Justify" onRun={() => exec("justifyFull")}><AlignJustify size={15} /></ToolbarButton>
            <ToolbarButton title="Bulleted list" onRun={() => exec("insertUnorderedList")}><List size={15} /></ToolbarButton>
            <ToolbarButton title="Numbered list" onRun={() => exec("insertOrderedList")}><ListOrdered size={15} /></ToolbarButton>
            <ToolbarButton title="Indent" onRun={() => exec("indent")}><Indent size={15} /></ToolbarButton>
            <ToolbarButton title="Outdent" onRun={() => exec("outdent")}><Outdent size={15} /></ToolbarButton>
            <ToolbarButton title="Insert link" shortcut="Ctrl+K" onRun={insertLink}><Link2 size={15} /></ToolbarButton>
            <ToolbarButton title="Remove formatting" onRun={() => exec("removeFormat")}><RemoveFormatting size={15} /></ToolbarButton>
          </div>
          <div
            ref={editorRef}
            contentEditable
            role="textbox"
            aria-label="Email body"
            aria-multiline="true"
            onInput={(e) => setBodyHtml(e.currentTarget.innerHTML)}
            onDrop={(e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); e.stopPropagation(); setDragging(false); addFiles(e.dataTransfer.files); } }}
            style={{ minHeight: "220px", maxHeight: "50vh", overflowY: "auto", padding: "0.75rem", border: "1px solid var(--border-color)", borderRadius: "0 0 10px 10px", outline: "none", fontSize: "0.92rem", lineHeight: 1.55 }}
          />
        </div>

        <div>
          <input ref={fileInputRef} type="file" multiple onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} style={{ display: "none" }} />
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={attachments.length >= MAX_ATTACHMENTS} style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", padding: "0.45rem 0.8rem", background: "transparent", border: "1px solid var(--border-color)", borderRadius: "8px", color: "var(--text-secondary)", fontSize: "0.82rem", cursor: attachments.length >= MAX_ATTACHMENTS ? "not-allowed" : "pointer", opacity: attachments.length >= MAX_ATTACHMENTS ? 0.6 : 1 }}>
            <Paperclip size={14} /> Attach files {attachments.length > 0 && <span style={{ color: "var(--accent-color)", fontWeight: 700 }}>({attachments.length}/{MAX_ATTACHMENTS})</span>}
          </button>
          {attachments.length > 0 && (
            <ul style={{ listStyle: "none", margin: "0.6rem 0 0", padding: 0, display: "flex", flexDirection: "column", gap: "0.4rem" }}>
              {attachments.map((f, i) => (
                <li key={`${f.name}-${f.size}-${i}`} style={{ display: "flex", alignItems: "center", gap: "0.6rem", padding: "0.5rem 0.7rem", border: "1px solid var(--border-color)", borderRadius: "10px", background: "var(--subtle-bg-2)", fontSize: "0.82rem", flexWrap: "wrap" }}>
                  <Paperclip size={13} color="var(--accent-color)" />
                  <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "240px" }}>{f.name}</span>
                  <span style={{ color: "var(--text-secondary)" }}>{f.type || "file"}</span>
                  <span style={{ color: "var(--text-secondary)" }}>{formatSize(f.size)}</span>
                  <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setAttachments((prev) => prev.filter((_, x) => x !== i))} style={{ marginLeft: "auto", background: "transparent", border: "none", cursor: "pointer", color: "var(--text-secondary)", display: "inline-flex" }}>
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", flexWrap: "wrap", paddingTop: "0.4rem", borderTop: "1px solid var(--border-color)" }}>
          <span style={{ marginRight: "auto", fontSize: "0.75rem", color: "var(--text-secondary)", alignSelf: "center" }}>Ctrl+Enter to send · Ctrl+K for link · Esc to go back</span>
          <button type="submit" disabled={sending} style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", padding: "0.55rem 1.4rem", borderRadius: "8px", border: "none", background: "var(--accent-color)", color: "#fff", cursor: sending ? "not-allowed" : "pointer", opacity: sending ? 0.7 : 1, fontWeight: 700, fontSize: "0.88rem" }}>
            <Send size={14} /> {sending ? "Sending..." : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}
