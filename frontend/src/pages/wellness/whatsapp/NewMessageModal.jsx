
import {
  MessageCircle,
  X,
  Send,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useWhatsAppThreads } from './WhatsAppThreadsContext';

export default function NewMessageModal() {
  const {
    showNewModal,
    setShowNewModal,
    newPhone,
    setNewPhone,
    newBody,
    setNewBody,
    newSending,
    newError,
    sendNewMessage,
    useTemplate,
    setUseTemplate,
    selectedTemplateName,
    setSelectedTemplateName,
    templateParams,
    setTemplateParams,
    templates,
    contactOptions,
    pickerOpen,
    setPickerOpen,
    // Optional override so non-wellness hosts (the travel Wati chat) can
    // route the "manage templates" links to their own templates surface.
    // Wellness's WhatsAppThreads.jsx doesn't set it → default preserved.
    templatesPath,
  } = useWhatsAppThreads();

  const tplPath = templatesPath || '/wellness/whatsapp/templates';

  if (!showNewModal) return null;

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) setShowNewModal(false); }}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999, padding: '1rem',
      }}
    >
      <div
        className="glass-card"
        style={{
          width: '100%', maxWidth: 480,
          padding: '1.5rem', borderRadius: 12,
          background: 'var(--surface-color)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-color)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0, fontSize: '1.1rem', display: 'flex', alignItems: 'center', gap: 8 }}>
            <MessageCircle size={18} color="var(--primary-color, #25D366)" />
            New WhatsApp Message
          </h3>
          <button
            onClick={() => setShowNewModal(false)}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--text-secondary)', padding: 4, display: 'flex',
            }}
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1rem', lineHeight: 1.5 }}>
          Send a message to a new number. Free-form text only works if the recipient
          has messaged you in the last 24 hours — otherwise use an approved template.
        </p>

        <label style={{ display: 'block', marginBottom: '0.75rem', position: 'relative' }}>
          <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 4 }}>
            Phone or pick a contact
          </span>
          <input
            type="text"
            value={newPhone}
            onChange={(e) => { setNewPhone(e.target.value); setPickerOpen(true); }}
            onFocus={() => setPickerOpen(true)}
            onBlur={() => setTimeout(() => setPickerOpen(false), 150)}
            placeholder="Type a name or phone…"
            className="input-field"
            style={{ width: '100%', fontSize: '0.9rem' }}
            disabled={newSending}
            autoComplete="off"
          />
          {pickerOpen && contactOptions.length > 0 && (() => {
            const query = newPhone.trim().toLowerCase();
            // Filter: empty query → show first 20; otherwise match
            // name OR phone, case-insensitive.
            const filtered = query
              ? contactOptions.filter((o) =>
                  o.name.toLowerCase().includes(query) || o.phone.toLowerCase().includes(query)
                ).slice(0, 30)
              : contactOptions.slice(0, 20);
            if (filtered.length === 0) return null;
            return (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0,
                background: 'var(--bg-color)', border: '1px solid var(--border-color)',
                borderRadius: 8, marginTop: 4, maxHeight: 220, overflowY: 'auto',
                zIndex: 10000, boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
              }}>
                {filtered.map((o) => (
                  <div
                    key={o.id}
                    onMouseDown={(e) => {
                      e.preventDefault(); // prevent blur before click registers
                      setNewPhone(o.phone);
                      setPickerOpen(false);
                    }}
                    style={{
                      padding: '0.55rem 0.8rem',
                      cursor: 'pointer',
                      borderBottom: '1px solid var(--border-color)',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      gap: 8,
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--hover-bg, rgba(127,127,127,0.08))'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span style={{ fontSize: '0.88rem', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {o.name}
                      </span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        {o.phone}
                      </span>
                    </div>
                    <span style={{
                      fontSize: '0.65rem', fontWeight: 600,
                      padding: '2px 6px', borderRadius: 4,
                      background: o.source === 'patient' ? 'rgba(16,185,129,0.15)' : 'rgba(59,130,246,0.15)',
                      color: o.source === 'patient' ? '#10b981' : '#3b82f6',
                      textTransform: 'uppercase', letterSpacing: '0.04em',
                    }}>
                      {o.source}
                    </span>
                  </div>
                ))}
              </div>
            );
          })()}
        </label>

        {/* Use Template toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '0.75rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={useTemplate}
              onChange={(e) => setUseTemplate(e.target.checked)}
              disabled={newSending}
            />
            Use Template (required to message cold numbers)
          </label>
          {templates.length === 0 && useTemplate && (
            <Link to={tplPath} style={{ fontSize: '0.75rem', color: 'var(--primary-color, #25D366)' }}>
              Create one →
            </Link>
          )}
        </div>

        {useTemplate ? (
          <>
            <label style={{ display: 'block', marginBottom: '0.75rem' }}>
              <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 4 }}>
                Approved Template
              </span>
              <select
                value={selectedTemplateName}
                onChange={(e) => setSelectedTemplateName(e.target.value)}
                className="input-field"
                style={{ width: '100%', fontSize: '0.9rem' }}
                disabled={newSending}
              >
                <option value="">— Select a template —</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.name}>
                    {t.name} ({t.category} · {t.language})
                  </option>
                ))}
              </select>
              {templates.length === 0 && (
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  No approved templates yet. <Link to={tplPath} style={{ color: 'var(--primary-color, #25D366)' }}>Create one</Link> first.
                </span>
              )}
            </label>

            {selectedTemplateName && (() => {
              const tpl = templates.find((t) => t.name === selectedTemplateName);
              return (
                <>
                  <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '0.6rem 0.8rem', marginBottom: '0.75rem', fontSize: '0.82rem', whiteSpace: 'pre-wrap' }}>
                    {tpl.body}
                  </div>
                  {templateParams.map((val, idx) => (
                    <label key={idx} style={{ display: 'block', marginBottom: '0.5rem' }}>
                      <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
                        Variable {`{{${idx + 1}}}`}
                      </span>
                      <input
                        value={val}
                        onChange={(e) => {
                          const next = [...templateParams];
                          next[idx] = e.target.value;
                          setTemplateParams(next);
                        }}
                        className="input-field"
                        style={{ width: '100%', fontSize: '0.88rem' }}
                        disabled={newSending}
                      />
                    </label>
                  ))}
                </>
              );
            })()}
          </>
        ) : (
          <label style={{ display: 'block', marginBottom: '0.75rem' }}>
            <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 4 }}>
              Message
            </span>
            <textarea
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
              rows={4}
              placeholder="Hi! Just checking in…"
              className="input-field"
              style={{ width: '100%', fontSize: '0.9rem', fontFamily: 'inherit', resize: 'vertical' }}
              disabled={newSending}
            />
          </label>
        )}

        {newError && (
          <div style={{
            background: 'rgba(220,38,38,0.1)', color: '#dc2626',
            border: '1px solid rgba(220,38,38,0.3)',
            padding: '0.6rem 0.8rem', borderRadius: 6,
            fontSize: '0.8rem', marginBottom: '0.75rem', lineHeight: 1.5,
          }}>
            {newError}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
          <button
            onClick={() => setShowNewModal(false)}
            disabled={newSending}
            className="btn-secondary"
            style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
          >
            Cancel
          </button>
          <button
            onClick={sendNewMessage}
            disabled={
              newSending ||
              !newPhone.trim() ||
              // Template mode validates the picked template + every
              // {{n}} variable; free-form mode validates the body. Mirrors
              // the same checks in sendNewMessage. The old condition always
              // required newBody, so template sends (body empty by design)
              // left the button permanently disabled.
              (useTemplate
                ? (!selectedTemplateName || templateParams.some((p) => !p.trim()))
                : !newBody.trim())
            }
            style={{
              padding: '0.5rem 1rem', fontSize: '0.85rem',
              background: 'var(--primary-color, #25D366)', color: '#fff',
              border: 'none', borderRadius: 6, fontWeight: 600,
              cursor: newSending ? 'not-allowed' : 'pointer',
              opacity: newSending ? 0.6 : 1,
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <Send size={14} />
            {newSending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
