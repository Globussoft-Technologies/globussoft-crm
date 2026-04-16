import React, { useEffect, useMemo, useState } from 'react';
import { Bot, Plus, Edit, Play, Power, Trash2, Copy, X, ChevronUp, ChevronDown, Send, MessageCircle } from 'lucide-react';
import { fetchApi } from '../utils/api';

const NODE_TYPES = [
  { value: 'message', label: 'Message', help: 'Send a static message' },
  { value: 'question', label: 'Question', help: 'Ask a question; wait for any reply' },
  { value: 'capture-email', label: 'Capture Email', help: 'Validate and save email' },
  { value: 'capture-phone', label: 'Capture Phone', help: 'Validate and save phone' },
  { value: 'branch', label: 'Branch', help: 'Send a message; route by edge condition' },
  { value: 'end', label: 'End', help: 'End the conversation' },
];

function genId() {
  return 'n_' + Math.random().toString(36).slice(2, 9);
}

function defaultFlow() {
  const a = genId();
  const b = genId();
  return {
    nodes: [
      { id: a, type: 'message', content: 'Hi! How can we help you today?' },
      { id: b, type: 'capture-email', content: 'Drop your email and we will get back to you.' },
    ],
    edges: [{ from: a, to: b }],
  };
}

export default function Chatbots() {
  const [bots, setBots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // bot being edited
  const [testing, setTesting] = useState(null); // bot being tested
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const tenantId = useMemo(() => {
    try {
      const tok = localStorage.getItem('token');
      if (!tok) return 1;
      const p = JSON.parse(atob(tok.split('.')[1] || ''));
      return p.tenantId || 1;
    } catch { return 1; }
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchApi('/api/chatbots');
      setBots(Array.isArray(data) ? data : []);
    } catch { setBots([]); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      const bot = await fetchApi('/api/chatbots', {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim(), flow: defaultFlow() }),
      });
      setCreating(false);
      setNewName('');
      await load();
      setEditing(bot);
    } catch (e) {
      alert('Create failed: ' + e.message);
    }
  };

  const toggleActive = async (bot) => {
    try {
      await fetchApi(`/api/chatbots/${bot.id}/${bot.isActive ? 'deactivate' : 'activate'}`, { method: 'POST' });
      load();
    } catch (e) { alert('Toggle failed'); }
  };

  const deleteBot = async (bot) => {
    if (!window.confirm(`Delete bot "${bot.name}"? All conversations will be removed.`)) return;
    try {
      await fetchApi(`/api/chatbots/${bot.id}`, { method: 'DELETE' });
      load();
    } catch (e) { alert('Delete failed'); }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Bot size={26} style={{ color: 'var(--accent-color, #6366f1)' }} />
          <div>
            <h2 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700 }}>Chatbots</h2>
            <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              Build no-code conversational bots to qualify leads
            </p>
          </div>
        </div>
        <button className="btn-primary" onClick={() => setCreating(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Plus size={16} /> Create Bot
        </button>
      </header>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>Loading bots...</div>
      ) : bots.length === 0 ? (
        <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>
          <Bot size={48} style={{ opacity: 0.3, marginBottom: '0.75rem' }} />
          <h3 style={{ margin: 0, marginBottom: '0.5rem' }}>No chatbots yet</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Create your first bot to start engaging visitors.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1.25rem' }}>
          {bots.map(bot => (
            <div key={bot.id} className="card" style={{ padding: '1.25rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 10,
                    background: 'rgba(99,102,241,0.15)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Bot size={20} color="#6366f1" />
                  </div>
                  <div>
                    <div style={{ fontWeight: 700 }}>{bot.name}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {bot.conversationCount || 0} conversations
                    </div>
                  </div>
                </div>
                <span style={{
                  padding: '0.2rem 0.55rem', borderRadius: 999, fontSize: '0.7rem', fontWeight: 600,
                  background: bot.isActive ? 'rgba(16,185,129,0.15)' : 'rgba(107,114,128,0.15)',
                  color: bot.isActive ? '#10b981' : '#9ca3af',
                }}>{bot.isActive ? 'ACTIVE' : 'INACTIVE'}</span>
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                {(bot.flow && bot.flow.nodes ? bot.flow.nodes.length : 0)} nodes
              </div>
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                <button className="btn-secondary" onClick={() => setEditing(bot)} style={btnSm}>
                  <Edit size={14} /> Edit Flow
                </button>
                <button className="btn-secondary" onClick={() => setTesting(bot)} style={btnSm}>
                  <Play size={14} /> Test
                </button>
                <button className="btn-secondary" onClick={() => toggleActive(bot)} style={btnSm}>
                  <Power size={14} /> {bot.isActive ? 'Disable' : 'Enable'}
                </button>
                <button className="btn-secondary" onClick={() => deleteBot(bot)} style={{ ...btnSm, color: '#ef4444' }}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <Modal onClose={() => setCreating(false)} title="Create Chatbot" maxWidth={420}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Bot name</label>
            <input
              autoFocus
              className="input"
              style={inputStyle}
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="Sales Qualifier"
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
              <button className="btn-secondary" onClick={() => setCreating(false)}>Cancel</button>
              <button className="btn-primary" onClick={handleCreate}>Create</button>
            </div>
          </div>
        </Modal>
      )}

      {editing && (
        <FlowEditor
          bot={editing}
          tenantId={tenantId}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}

      {testing && (
        <BotTester
          bot={testing}
          tenantId={tenantId}
          onClose={() => setTesting(null)}
        />
      )}
    </div>
  );
}

// ── Flow Editor ─────────────────────────────────────────────────────
function FlowEditor({ bot, tenantId, onClose, onSaved }) {
  const [name, setName] = useState(bot.name);
  const [nodes, setNodes] = useState(bot.flow && bot.flow.nodes ? bot.flow.nodes : []);
  const [edges] = useState(bot.flow && bot.flow.edges ? bot.flow.edges : []);
  const [saving, setSaving] = useState(false);

  // Build implicit linear edges between nodes (UI is linear). We retain
  // any branch-condition edges from the original flow for branch nodes.
  const buildEdges = (ns) => {
    const linearEdges = [];
    for (let i = 0; i < ns.length - 1; i++) {
      // For branch nodes, keep their condition-based edges from original flow
      if (ns[i].type === 'branch') {
        const branchEdges = edges.filter(e => e.from === ns[i].id && e.condition);
        linearEdges.push(...branchEdges);
        // also default to next
        linearEdges.push({ from: ns[i].id, to: ns[i + 1].id });
      } else if (ns[i].type !== 'end') {
        linearEdges.push({ from: ns[i].id, to: ns[i + 1].id });
      }
    }
    return linearEdges;
  };

  const addNode = () => {
    setNodes([...nodes, { id: genId(), type: 'message', content: 'New message' }]);
  };

  const updateNode = (id, patch) => {
    setNodes(nodes.map(n => n.id === id ? { ...n, ...patch } : n));
  };

  const removeNode = (id) => {
    setNodes(nodes.filter(n => n.id !== id));
  };

  const moveNode = (id, dir) => {
    const idx = nodes.findIndex(n => n.id === id);
    if (idx < 0) return;
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= nodes.length) return;
    const copy = [...nodes];
    const [item] = copy.splice(idx, 1);
    copy.splice(newIdx, 0, item);
    setNodes(copy);
  };

  const save = async () => {
    setSaving(true);
    try {
      const flow = { nodes, edges: buildEdges(nodes) };
      await fetchApi(`/api/chatbots/${bot.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name, flow }),
      });
      onSaved();
    } catch (e) {
      alert('Save failed: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const snippet = `<script src="${origin}/crm-chat.js?bot=${bot.id}&tenant=${tenantId}"></script>`;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };

  return (
    <Modal onClose={onClose} title="Edit Flow" maxWidth={720}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <label style={lbl}>Bot name</label>
        <input className="input" style={inputStyle} value={name} onChange={e => setName(e.target.value)} />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem' }}>
          <h4 style={{ margin: 0 }}>Flow Nodes</h4>
          <button className="btn-secondary" onClick={addNode} style={btnSm}><Plus size={14} /> Add Node</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', maxHeight: 360, overflowY: 'auto', paddingRight: 4 }}>
          {nodes.length === 0 && (
            <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '1.5rem' }}>
              No nodes yet — click "Add Node" to begin.
            </div>
          )}
          {nodes.map((n, idx) => (
            <div key={n.id} style={{
              border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
              borderRadius: 10, padding: '0.75rem', background: 'rgba(255,255,255,0.02)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', minWidth: 22 }}>#{idx + 1}</span>
                <select value={n.type} onChange={e => updateNode(n.id, { type: e.target.value })} style={{ ...inputStyle, padding: '0.35rem 0.5rem', flex: '0 0 160px' }}>
                  {NODE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <div style={{ flex: 1 }} />
                <button className="btn-secondary" style={btnIcon} onClick={() => moveNode(n.id, -1)} disabled={idx === 0}><ChevronUp size={14} /></button>
                <button className="btn-secondary" style={btnIcon} onClick={() => moveNode(n.id, 1)} disabled={idx === nodes.length - 1}><ChevronDown size={14} /></button>
                <button className="btn-secondary" style={{ ...btnIcon, color: '#ef4444' }} onClick={() => removeNode(n.id)}><X size={14} /></button>
              </div>
              <textarea
                value={n.content || ''}
                onChange={e => updateNode(n.id, { content: e.target.value })}
                placeholder={n.type === 'capture-email' ? 'Prompt (e.g. "What\'s your email?")' : n.type === 'end' ? '(optional)' : 'Message text'}
                rows={2}
                style={{ ...inputStyle, width: '100%', resize: 'vertical' }}
              />
            </div>
          ))}
        </div>

        <div style={{ marginTop: '0.5rem', borderTop: '1px solid var(--border-color, rgba(255,255,255,0.08))', paddingTop: '0.75rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
            <strong style={{ fontSize: '0.85rem' }}>Embed snippet</strong>
            <button className="btn-secondary" onClick={copy} style={btnSm}><Copy size={14} /> {copied ? 'Copied!' : 'Copy'}</button>
          </div>
          <pre style={{
            background: 'rgba(0,0,0,0.4)', padding: '0.75rem', borderRadius: 8,
            color: '#a5b4fc', fontSize: '0.75rem', overflowX: 'auto', margin: 0,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}>{snippet}</pre>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Flow'}</button>
        </div>
      </div>
    </Modal>
  );
}

// ── Bot Tester ──────────────────────────────────────────────────────
function BotTester({ bot, tenantId, onClose }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [completed, setCompleted] = useState(false);
  const visitorId = useMemo(() => 'test_' + Math.random().toString(36).slice(2, 10), []);

  // Kick off the bot on mount
  useEffect(() => {
    (async () => {
      await send('');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async (text) => {
    setSending(true);
    if (text) setMessages(m => [...m, { from: 'user', text }]);
    try {
      const res = await fetchApi(`/api/chatbots/chat/${bot.id}`, {
        method: 'POST',
        body: JSON.stringify({ visitorId, message: text || undefined, tenantId }),
      });
      const replies = Array.isArray(res.replies) && res.replies.length ? res.replies : (res.reply ? [res.reply] : []);
      setMessages(m => [...m, ...replies.map(r => ({ from: 'bot', text: r }))]);
      setCompleted(!!res.completed);
    } catch (e) {
      setMessages(m => [...m, { from: 'bot', text: 'Error: ' + e.message }]);
    } finally {
      setSending(false);
    }
  };

  const submit = (e) => {
    e.preventDefault();
    if (!input.trim() || sending || completed) return;
    const txt = input.trim();
    setInput('');
    send(txt);
  };

  return (
    <Modal onClose={onClose} title={`Test: ${bot.name}`} maxWidth={460}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <div style={{
          background: 'rgba(0,0,0,0.25)', borderRadius: 10, padding: '0.75rem',
          minHeight: 280, maxHeight: 380, overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: '0.4rem',
        }}>
          {messages.length === 0 && (
            <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem 0' }}>
              <MessageCircle size={32} style={{ opacity: 0.3 }} />
              <div style={{ fontSize: '0.85rem', marginTop: 6 }}>Starting conversation…</div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} style={{
              alignSelf: m.from === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '80%',
              padding: '0.5rem 0.75rem',
              borderRadius: 12,
              background: m.from === 'user' ? 'linear-gradient(135deg,#6366f1,#8b5cf6)' : 'rgba(255,255,255,0.08)',
              color: m.from === 'user' ? '#fff' : 'var(--text-primary)',
              fontSize: '0.85rem',
              wordBreak: 'break-word',
            }}>{m.text}</div>
          ))}
          {sending && (
            <div style={{ alignSelf: 'flex-start', color: 'var(--text-secondary)', fontSize: '0.8rem', padding: '0.25rem 0.5rem' }}>
              Bot is typing…
            </div>
          )}
        </div>
        <form onSubmit={submit} style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            className="input"
            style={inputStyle}
            placeholder={completed ? 'Conversation ended' : 'Type a reply…'}
            value={input}
            onChange={e => setInput(e.target.value)}
            disabled={sending || completed}
          />
          <button className="btn-primary" type="submit" disabled={sending || completed || !input.trim()} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Send size={14} /> Send
          </button>
        </form>
        {completed && (
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', textAlign: 'center' }}>
            Conversation completed.
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── Modal ───────────────────────────────────────────────────────────
function Modal({ title, children, onClose, maxWidth = 520 }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: '1rem',
      }}>
      <div
        onClick={e => e.stopPropagation()}
        className="card"
        style={{ width: '100%', maxWidth, padding: '1.25rem', backdropFilter: 'blur(16px)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h3 style={{ margin: 0, fontSize: '1.1rem' }}>{title}</h3>
          <button onClick={onClose} className="btn-secondary" style={btnIcon}><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

const btnSm = { display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.4rem 0.7rem', fontSize: '0.78rem' };
const btnIcon = { padding: '0.35rem 0.5rem', display: 'flex', alignItems: 'center' };
const inputStyle = {
  background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
  borderRadius: 8, padding: '0.55rem 0.75rem', color: 'var(--text-primary)', fontSize: '0.875rem', width: '100%',
  fontFamily: 'inherit',
};
const lbl = { fontSize: '0.8rem', color: 'var(--text-secondary)' };
