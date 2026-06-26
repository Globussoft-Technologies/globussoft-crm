
import { useState } from 'react';
import {
  MessageCircle,
  CheckCheck,
  Clock,
  UserCheck,
  Ban,
  Edit2,
  Save,
  Trash2,
  X,
  Paperclip,
  Smile,
  Send,
} from 'lucide-react';
import { useWhatsAppThreads } from './WhatsAppThreadsContext';

// Common chat + travel emojis for the composer quick-picker (no extra dependency).
const COMPOSER_EMOJIS = ['😀', '😁', '😂', '🤣', '😊', '😍', '😘', '👍', '🙏', '🎉', '✅', '❤️', '🔥', '✈️', '🏨', '🧳', '🗺️', '📅', '📞', '💬', '👏', '🙌', '🤝', '💯', '😎', '🤔', '😅', '🙂', '👌', '🚀', '⭐', '💰', '📌', '🕋', '🌴', '☀️'];
import StatusPill from './StatusPill';
import DeliveryTicks from './DeliveryTicks';
import MessageMedia from './MessageMedia';
import { ThreadAvatar, prettyContactLine } from './ThreadList';

export default function ThreadDetail() {
  const [emojiOpen, setEmojiOpen] = useState(false);
  const {
    selectedId,
    detail,
    loadingDetail,
    isAdmin,
    staff,
    renaming,
    renameValue,
    renameSaving,
    setRenameValue,
    startRename,
    cancelRename,
    saveRename,
    assignToUser,
    snoozeThread,
    closeThread,
    optOutContact,
    unblockContact,
    deleteThread,
    reply,
    setReply,
    sending,
    sendReply,
    replyToMsg,
    setReplyToMsg,
    uploadingMedia,
    openFilePicker,
    onFilePicked,
    fileInputRef,
    messagesEndRef,
    setCtxMenu,
    setReactPanelOpen,
    setNewPhone,
    setUseTemplate,
    setNewBody,
    setNewError,
    setShowNewModal,
  } = useWhatsAppThreads();

  return (
    <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
      {!selectedId ? (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-secondary)', gap: 8, padding: '2rem',
        }}>
          <MessageCircle size={48} color="var(--text-secondary)" />
          <p>Select a thread to start replying.</p>
        </div>
      ) : loadingDetail || !detail?.thread ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: 'var(--text-secondary)' }}>Loading thread…</p>
        </div>
      ) : (
        <>
          {/* Header — two rows so the Status pill never overlaps the
              contact name + the action buttons sit on their own line. */}
          <header style={{
            padding: '0.9rem 1.5rem', borderBottom: '1px solid var(--border-color)',
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            {/* Row 1 — name (or phone) + Edit pencil + Status pill on the right */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <ThreadAvatar
                url={detail.thread.contactAvatar}
                label={detail.thread.contact?.name || detail.thread.contactName || detail.thread.patient?.name || detail.thread.contactPhone}
                size={38}
                clickable
              />
              {renaming ? (
                <>
                  <input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveRename();
                      if (e.key === 'Escape') cancelRename();
                    }}
                    placeholder="Save as…"
                    autoFocus
                    className="input-field"
                    style={{ fontSize: '0.95rem', fontWeight: 600, padding: '0.35rem 0.6rem', maxWidth: 280 }}
                    disabled={renameSaving}
                  />
                  <button
                    onClick={saveRename}
                    disabled={renameSaving || !renameValue.trim()}
                    title="Save name"
                    style={{
                      background: 'var(--primary-color, #25D366)', color: '#fff',
                      border: 'none', borderRadius: 6, padding: '0.35rem 0.6rem',
                      display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.8rem',
                      cursor: renameSaving ? 'not-allowed' : 'pointer',
                    }}
                  >
                    <Save size={14} />
                    {renameSaving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={cancelRename}
                    disabled={renameSaving}
                    className="btn-secondary"
                    style={{ fontSize: '0.8rem', padding: '0.35rem 0.6rem' }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <h2 style={{
                    fontSize: '1.05rem', fontWeight: 700, margin: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
                  }}>
                    {detail.thread.contact?.name || detail.thread.contactName || detail.thread.patient?.name || detail.thread.contactPhone}
                  </h2>
                  {isAdmin && (
                    <button
                      onClick={startRename}
                      title="Save contact name"
                      style={{
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        color: 'var(--text-secondary)', padding: 4, display: 'flex',
                      }}
                    >
                      <Edit2 size={14} />
                    </button>
                  )}
                </>
              )}
              <div style={{ marginLeft: 'auto', flexShrink: 0 }}>
                <StatusPill status={detail.thread.status} />
              </div>
            </div>

            {/* Row 2 — phone + assignment + snooze info */}
            <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', margin: 0 }}>
              {prettyContactLine(detail.thread.contactPhone)}
              {detail.thread.assignedTo && (
                <> · Assigned to {detail.thread.assignedTo.name || detail.thread.assignedTo.email}</>
              )}
              {detail.thread.snoozedUntil && (
                <> · Snoozed until {new Date(detail.thread.snoozedUntil).toLocaleString()}</>
              )}
            </p>

            {detail.optedOut && (
              <p style={{
                background: 'rgba(239,68,68,0.12)', color: '#dc2626',
                padding: '4px 10px', borderRadius: 8, fontSize: '0.75rem',
                margin: 0, display: 'inline-flex', alignItems: 'center', gap: 5,
                alignSelf: 'flex-start',
              }}>
                <Ban size={12} /> Opted out ({detail.optedOut.reason})
                on {new Date(detail.optedOut.capturedAt).toLocaleDateString()}
              </p>
            )}

            {/* Row 3 — action bar (assign dropdown + Snooze + Close + Opt out) */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {isAdmin ? (
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  <UserCheck size={14} />
                  <select
                    value={detail.thread.assignedToId || ''}
                    onChange={(e) => assignToUser(e.target.value || null)}
                    className="input-field"
                    style={{ fontSize: '0.8rem', padding: '0.35rem 0.5rem', minWidth: 160 }}
                    title="Assign to a teammate"
                  >
                    <option value="">Unassigned</option>
                    {staff.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name || u.email}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                // Read-only badge for non-admins / non-managers
                <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.8rem', color: 'var(--text-secondary)', padding: '0.35rem 0.5rem', border: '1px solid var(--border-color)', borderRadius: 6 }}>
                  <UserCheck size={14} />
                  {detail.thread.assignedTo
                    ? (detail.thread.assignedTo.name || detail.thread.assignedTo.email)
                    : 'Unassigned'}
                </span>
              )}
              <button onClick={snoozeThread} className="btn-secondary" style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Clock size={14} /> Snooze
              </button>
              <button onClick={closeThread} className="btn-secondary" style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem', display: 'flex', alignItems: 'center', gap: 4 }}>
                <CheckCheck size={14} /> Close
              </button>
              {!detail.optedOut ? (
                <button
                  onClick={optOutContact}
                  className="btn-secondary"
                  title="Block this number (blocks both inbound + outbound)"
                  style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem', display: 'flex', alignItems: 'center', gap: 4, color: '#dc2626' }}
                >
                  <Ban size={14} /> Block
                </button>
              ) : isAdmin && (
                <button
                  onClick={unblockContact}
                  className="btn-secondary"
                  title="Unblock this number — re-enables WhatsApp messaging"
                  style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem', display: 'flex', alignItems: 'center', gap: 4, color: '#16a34a' }}
                >
                  <CheckCheck size={14} /> Unblock
                </button>
              )}
              {isAdmin && (
                <button
                  onClick={deleteThread}
                  className="btn-secondary"
                  title="Delete this conversation (removes all messages from the CRM)"
                  style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem', display: 'flex', alignItems: 'center', gap: 4, color: '#dc2626' }}
                >
                  <Trash2 size={14} /> Delete chat
                </button>
              )}
            </div>
          </header>

          {/* Messages — uses the chat-specific theme vars added to
              src/index.css (--chat-bg, --chat-bubble-in, --chat-bubble-out)
              which are SOLID colors that adapt per theme. WhatsApp-style:
              light mode = cream backdrop + white inbound + pale-green
              outbound. Dark mode = near-black backdrop + dark-gray inbound
              + muted-teal outbound. Always solid (not translucent) so
              the bubble never blends into the backdrop. */}
          <div style={{
            flex: 1, overflowY: 'auto', padding: '1.5rem',
            display: 'flex', flexDirection: 'column', gap: 18,
            background: 'var(--chat-bg)',
          }}>
            {(detail.messages || [])
              // Hide Meta "reaction" events from the chat view — they
              // arrive as full inbound messages with body=null and were
              // previously rendering as "(media)" placeholders. Future
              // work: stash them on the original message and render as
              // a small emoji pill. For now, just hide.
              .filter((m) => (m.metaType || '').toLowerCase() !== 'reaction')
              .map((m) => {
                const isOutbound = m.direction === 'OUTBOUND';
                const hasMedia = !!m.mediaUrl;
                return (
                  <div
                    key={m.id}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setReactPanelOpen(false);
                      setCtxMenu({ x: e.clientX, y: e.clientY, message: m });
                    }}
                    style={{
                      maxWidth: '70%',
                      alignSelf: isOutbound ? 'flex-end' : 'flex-start',
                      background: isOutbound ? 'var(--chat-bubble-out)' : 'var(--chat-bubble-in)',
                      color: 'var(--text-primary)',
                      padding: '0.6rem 0.85rem', borderRadius: 12,
                      fontSize: '0.9rem', lineHeight: 1.4,
                      wordBreak: 'break-word',
                      boxShadow: '0 1px 1px rgba(0,0,0,0.13)',
                      position: 'relative',
                      cursor: 'context-menu',
                    }}
                  >
                    <div>
                      {hasMedia && <MessageMedia message={m} />}
                      {m.body && <div style={{ marginTop: hasMedia ? 6 : 0 }}>{m.body}</div>}
                      {!hasMedia && !m.body && <em style={{ opacity: 0.6 }}>(empty)</em>}
                    </div>
                    {/* Reactions pill — shows emojis from both sides
                        (customer's reactions arrive via webhook, the
                        operator's reactions are mirrored locally by the
                        /react endpoint). Grouped + counted so "👍👍❤️"
                        renders as "👍 2 · ❤️ 1". */}
                    {(() => {
                      let arr = [];
                      try { arr = JSON.parse(m.reactionsJson || '[]'); } catch { arr = []; }
                      if (!Array.isArray(arr) || arr.length === 0) return null;
                      const counts = arr.reduce((acc, r) => {
                        const e = r?.emoji || '';
                        if (!e) return acc;
                        acc[e] = (acc[e] || 0) + 1;
                        return acc;
                      }, {});
                      const entries = Object.entries(counts);
                      if (entries.length === 0) return null;
                      return (
                        <div style={{
                          position: 'absolute',
                          bottom: -10,
                          [isOutbound ? 'right' : 'left']: 8,
                          background: 'var(--bg-color)',
                          border: '1px solid var(--border-color)',
                          borderRadius: 999,
                          padding: '1px 6px',
                          fontSize: '0.78rem',
                          display: 'flex', gap: 4, alignItems: 'center',
                          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                          whiteSpace: 'nowrap',
                          lineHeight: 1.4,
                        }}>
                          {entries.map(([emoji, count]) => (
                            <span key={emoji}>
                              {emoji}{count > 1 ? ` ${count}` : ''}
                            </span>
                          ))}
                        </div>
                      );
                    })()}
                    <div style={{
                      fontSize: '0.65rem', opacity: 0.65, marginTop: 4,
                      textAlign: isOutbound ? 'right' : 'left',
                      display: 'flex',
                      gap: 4,
                      alignItems: 'center',
                      justifyContent: isOutbound ? 'flex-end' : 'flex-start',
                    }}>
                      <span>{new Date(m.createdAt).toLocaleString()}</span>
                      <DeliveryTicks status={m.status} direction={m.direction} />
                    </div>
                    {isOutbound && m.status === 'FAILED' && (
                      <div
                        data-testid="message-failed-reason"
                        style={{
                          fontSize: '0.7rem',
                          color: '#ef4444',
                          marginTop: 2,
                          textAlign: 'right',
                        }}
                      >
                        Not delivered{m.errorMessage ? ` — ${m.errorMessage}` : ''}
                      </div>
                    )}
                  </div>
                );
              })}
            <div ref={messagesEndRef} />
          </div>

          {/* Reply box */}
          <footer style={{ padding: '1rem 1.5rem', borderTop: '1px solid var(--border-color)' }}>
            {detail.optedOut ? (
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', textAlign: 'center', padding: '0.75rem' }}>
                Reply box disabled — contact has opted out (DPDP/TRAI compliance).
              </p>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {/* WhatsApp-style replying-to preview: shows the quoted
                      message in a green-bordered bar above the textarea
                      with an X to dismiss. Replaces the old text-quote
                      approach which polluted the textarea. */}
                  {replyToMsg && (
                    <div style={{
                      display: 'flex', alignItems: 'stretch', gap: 8,
                      background: 'var(--surface-color)',
                      borderRadius: 6,
                      borderLeft: '3px solid var(--primary-color, #25D366)',
                      padding: '0.5rem 0.7rem',
                      fontSize: '0.82rem',
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          color: 'var(--primary-color, #25D366)',
                          fontSize: '0.72rem', fontWeight: 600, marginBottom: 2,
                        }}>
                          Replying to {replyToMsg.direction === 'OUTBOUND' ? 'yourself' : (detail.thread.contact?.name || detail.thread.contactPhone)}
                        </div>
                        <div style={{
                          color: 'var(--text-secondary)',
                          overflow: 'hidden', textOverflow: 'ellipsis',
                          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                        }}>
                          {replyToMsg.body || '(media)'}
                        </div>
                      </div>
                      <button
                        onClick={() => setReplyToMsg(null)}
                        title="Cancel reply"
                        style={{
                          background: 'transparent', border: 'none', cursor: 'pointer',
                          color: 'var(--text-secondary)', padding: 4, display: 'flex',
                          alignItems: 'flex-start',
                        }}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}
                  <div style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'flex-end',
                    background: 'var(--surface-color)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 24,
                    padding: 6,
                    backdropFilter: 'blur(8px)',
                    WebkitBackdropFilter: 'blur(8px)',
                  }}>
                    {/* Paperclip — opens hidden file input. The textarea
                        content (if any) becomes the media caption. */}
                    <input
                      ref={fileInputRef}
                      type="file"
                      onChange={onFilePicked}
                      style={{ display: 'none' }}
                      accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
                    />
                    <button
                      type="button"
                      onClick={openFilePicker}
                      disabled={uploadingMedia}
                      title="Attach a file (image / video / audio / document, max 16 MB)"
                      style={{
                        width: 36, height: 36,
                        flexShrink: 0,
                        background: 'transparent',
                        border: 'none',
                        borderRadius: '50%',
                        color: 'var(--text-secondary)',
                        cursor: uploadingMedia ? 'not-allowed' : 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        opacity: uploadingMedia ? 0.5 : 1,
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={(e) => { if (!uploadingMedia) e.currentTarget.style.background = 'var(--hover-bg)'; }}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                      <Paperclip size={18} />
                    </button>
                    {/* Emoji quick-picker — appends to the composer (no extra dep). */}
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <button
                        type="button"
                        onClick={() => setEmojiOpen((o) => !o)}
                        disabled={uploadingMedia}
                        title="Emoji"
                        aria-label="Insert emoji"
                        aria-expanded={emojiOpen}
                        style={{
                          width: 36, height: 36, background: 'transparent', border: 'none',
                          borderRadius: '50%', color: emojiOpen ? 'var(--primary-color, #25D366)' : 'var(--text-secondary)',
                          cursor: uploadingMedia ? 'not-allowed' : 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          opacity: uploadingMedia ? 0.5 : 1, transition: 'background 0.15s',
                        }}
                        onMouseEnter={(e) => { if (!uploadingMedia) e.currentTarget.style.background = 'var(--hover-bg)'; }}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                      >
                        <Smile size={18} />
                      </button>
                      {emojiOpen && (
                        <div
                          role="menu"
                          aria-label="Emoji picker"
                          style={{
                            position: 'absolute', bottom: 44, left: 0, zIndex: 40,
                            width: 248, maxHeight: 180, overflowY: 'auto',
                            display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 2, padding: 8,
                            background: 'var(--surface-color)', border: '1px solid var(--border-color)',
                            borderRadius: 12, boxShadow: '0 8px 28px rgba(0,0,0,0.28)',
                          }}
                        >
                          {COMPOSER_EMOJIS.map((emo) => (
                            <button
                              key={emo}
                              type="button"
                              onClick={() => setReply((prev) => (prev || '') + emo)}
                              aria-label={`Insert ${emo}`}
                              style={{
                                fontSize: 18, lineHeight: 1, padding: 4, background: 'transparent',
                                border: 'none', cursor: 'pointer', borderRadius: 6,
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--hover-bg)'; }}
                              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                            >
                              {emo}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <textarea
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                          e.preventDefault();
                          sendReply();
                        }
                        if (e.key === 'Escape' && replyToMsg) {
                          setReplyToMsg(null);
                        }
                      }}
                      placeholder={uploadingMedia ? 'Uploading…' : (replyToMsg ? 'Type your reply…' : 'Type a message…')}
                      rows={1}
                      style={{
                        flex: 1,
                        minHeight: 24,
                        maxHeight: 140,
                        resize: 'none',
                        fontSize: '0.92rem',
                        border: 'none',
                        outline: 'none',
                        background: 'transparent',
                        color: 'var(--text-primary)',
                        fontFamily: 'inherit',
                        padding: '7px 4px',
                        lineHeight: 1.4,
                      }}
                      disabled={uploadingMedia}
                    />
                    <button
                      onClick={sendReply}
                      disabled={sending || !reply.trim()}
                      title="Send (Ctrl+Enter)"
                      style={{
                        width: 36, height: 36,
                        flexShrink: 0,
                        background: (sending || !reply.trim()) ? 'transparent' : 'var(--primary-color, #25D366)',
                        border: 'none',
                        borderRadius: '50%',
                        color: (sending || !reply.trim()) ? 'var(--text-secondary)' : '#fff',
                        cursor: (sending || !reply.trim()) ? 'not-allowed' : 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'background 0.15s',
                      }}
                    >
                      <Send size={16} />
                    </button>
                  </div>
                </div>
            )}
          </footer>
        </>
      )}
    </main>
  );
}
