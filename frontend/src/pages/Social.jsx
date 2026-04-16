import React, { useState, useEffect, useMemo } from 'react';
import { Send, Calendar, AtSign, Link as LinkIcon, Settings, Hash, Globe, Share2, Trash2, Plus, RefreshCw, Check, X } from 'lucide-react';
import { fetchApi } from '../utils/api';

const PLATFORMS = [
  { id: 'linkedin', name: 'LinkedIn', icon: Globe,  color: '#0a66c2', max: 2200 },
  { id: 'twitter',  name: 'Twitter',  icon: Hash,   color: '#1da1f2', max: 280 },
  { id: 'facebook', name: 'Facebook', icon: Share2, color: '#1877f2', max: 2200 },
];

const STATUS_COLORS = {
  DRAFT:     { bg: 'rgba(107,114,128,0.15)', color: '#6b7280' },
  SCHEDULED: { bg: 'rgba(59,130,246,0.15)',  color: '#3b82f6' },
  PUBLISHED: { bg: 'rgba(16,185,129,0.15)',  color: '#10b981' },
  FAILED:    { bg: 'rgba(239,68,68,0.15)',   color: '#ef4444' },
};

const SENTIMENT_COLORS = {
  positive: '#10b981',
  neutral:  '#6b7280',
  negative: '#ef4444',
};

function platformMeta(id) {
  return PLATFORMS.find(p => p.id === id) || { name: id, icon: AtSign, color: '#888', max: 2200 };
}

export default function Social() {
  const [tab, setTab] = useState('compose');
  const [posts, setPosts] = useState([]);
  const [mentions, setMentions] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [contacts, setContacts] = useState([]);

  // compose state
  const [selectedPlatforms, setSelectedPlatforms] = useState(['linkedin']);
  const [content, setContent] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduleTime, setScheduleTime] = useState('');
  const [busy, setBusy] = useState(false);

  // accounts modal
  const [connectModal, setConnectModal] = useState(null); // platform id
  const [connectToken, setConnectToken] = useState('');
  const [connectSecret, setConnectSecret] = useState('');

  const loadAll = () => {
    fetchApi('/api/social/posts').then(d => setPosts(Array.isArray(d) ? d : [])).catch(() => setPosts([]));
    fetchApi('/api/social/mentions').then(d => setMentions(Array.isArray(d) ? d : [])).catch(() => setMentions([]));
    fetchApi('/api/social/accounts').then(d => setAccounts(Array.isArray(d) ? d : [])).catch(() => setAccounts([]));
    fetchApi('/api/contacts').then(d => setContacts(Array.isArray(d) ? d : (d?.contacts || []))).catch(() => setContacts([]));
  };

  useEffect(() => { loadAll(); }, []);

  const togglePlatform = (id) => {
    setSelectedPlatforms(prev => prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]);
  };

  const charLimit = useMemo(() => {
    if (selectedPlatforms.length === 0) return 2200;
    return Math.min(...selectedPlatforms.map(p => platformMeta(p).max));
  }, [selectedPlatforms]);

  const overLimit = content.length > charLimit;

  const buildScheduledFor = () => {
    if (!scheduleDate) return null;
    const time = scheduleTime || '09:00';
    const iso = new Date(`${scheduleDate}T${time}`).toISOString();
    return iso;
  };

  const submitPost = async (publishNow) => {
    if (!content.trim()) { alert('Content is required'); return; }
    if (selectedPlatforms.length === 0) { alert('Select at least one platform'); return; }
    if (overLimit) { alert(`Content exceeds ${charLimit} character limit`); return; }

    setBusy(true);
    try {
      const scheduledFor = publishNow ? null : buildScheduledFor();
      const created = [];
      for (const platform of selectedPlatforms) {
        const post = await fetchApi('/api/social/posts', {
          method: 'POST',
          body: JSON.stringify({ platform, content, mediaUrl: mediaUrl || null, scheduledFor }),
        });
        created.push(post);
      }
      if (publishNow) {
        for (const p of created) {
          try {
            const r = await fetchApi(`/api/social/posts/${p.id}/publish`, { method: 'POST' });
            if (!r.success) {
              alert(`Failed to publish to ${p.platform}: ${r.error || 'unknown error'}`);
            }
          } catch (e) {
            alert(`Failed to publish to ${p.platform}: ${e.message}`);
          }
        }
      }
      setContent(''); setMediaUrl(''); setScheduleDate(''); setScheduleTime('');
      loadAll();
      setTab(publishNow ? 'compose' : 'scheduled');
    } catch (e) {
      alert(`Failed to create post: ${e.message}`);
    }
    setBusy(false);
  };

  const cancelScheduled = async (id) => {
    if (!window.confirm('Cancel this scheduled post?')) return;
    await fetchApi(`/api/social/posts/${id}`, { method: 'DELETE' });
    loadAll();
  };

  const fetchMentionsFor = async (platform) => {
    setBusy(true);
    try {
      await fetchApi(`/api/social/mentions/fetch/${platform}`, {
        method: 'POST',
        body: JSON.stringify({ keywords: ['globussoft', 'crm'] }),
      });
      loadAll();
    } catch (e) {
      alert(`Fetch failed: ${e.message}`);
    }
    setBusy(false);
  };

  const linkMentionToContact = async (mentionId) => {
    const idStr = window.prompt('Enter Contact ID to link:');
    if (!idStr) return;
    try {
      await fetchApi(`/api/social/mentions/${mentionId}/link-contact`, {
        method: 'POST',
        body: JSON.stringify({ contactId: parseInt(idStr, 10) }),
      });
      loadAll();
    } catch (e) {
      alert(`Link failed: ${e.message}`);
    }
  };

  const submitConnect = async () => {
    if (!connectToken.trim()) { alert('Access token required'); return; }
    try {
      await fetchApi(`/api/social/accounts/${connectModal}/connect`, {
        method: 'POST',
        body: JSON.stringify({ accessToken: connectToken, accessSecret: connectSecret || undefined }),
      });
      setConnectModal(null); setConnectToken(''); setConnectSecret('');
      loadAll();
    } catch (e) {
      alert(`Connect failed: ${e.message}`);
    }
  };

  const disconnect = async (platform) => {
    if (!window.confirm(`Disconnect ${platform}?`)) return;
    await fetchApi(`/api/social/accounts/${platform}`, { method: 'DELETE' });
    loadAll();
  };

  const scheduledPosts = posts.filter(p => p.status === 'SCHEDULED' || p.status === 'DRAFT');

  const tabBtn = (key, label) => (
    <button
      key={key}
      onClick={() => setTab(key)}
      style={{
        padding: '0.6rem 1rem',
        background: tab === key ? 'rgba(99,102,241,0.18)' : 'transparent',
        color: tab === key ? 'var(--accent-color)' : 'var(--text-secondary)',
        border: 'none',
        borderBottom: tab === key ? '2px solid var(--accent-color)' : '2px solid transparent',
        cursor: 'pointer',
        fontWeight: 600,
      }}>
      {label}
    </button>
  );

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Send size={24} style={{ color: 'var(--accent-color)' }} />
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Social Media</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              Compose, schedule, and monitor social activity across LinkedIn, Twitter, and Facebook
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {accounts.map(a => {
            const pm = platformMeta(a.platform);
            const Icon = pm.icon;
            return (
              <span key={a.platform} title={`${pm.name}: ${a.connected ? 'Connected' : 'Not connected'}`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
                  padding: '0.3rem 0.6rem', borderRadius: '999px',
                  background: a.connected ? 'rgba(16,185,129,0.15)' : 'rgba(107,114,128,0.15)',
                  color: a.connected ? '#10b981' : '#6b7280', fontSize: '0.75rem', fontWeight: 600,
                }}>
                <Icon size={12} /> {pm.name}
              </span>
            );
          })}
        </div>
      </header>

      <div style={{ borderBottom: '1px solid var(--border-color)', marginBottom: '1.5rem', display: 'flex', gap: '0.25rem' }}>
        {tabBtn('compose', 'Compose')}
        {tabBtn('scheduled', `Scheduled (${scheduledPosts.length})`)}
        {tabBtn('mentions', `Mentions (${mentions.length})`)}
        {tabBtn('accounts', 'Accounts')}
      </div>

      {/* COMPOSE */}
      {tab === 'compose' && (
        <div className="card" style={{ padding: '1.5rem', maxWidth: 720 }}>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.5rem', fontWeight: 600 }}>
              Post to
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {PLATFORMS.map(p => {
                const Icon = p.icon;
                const active = selectedPlatforms.includes(p.id);
                return (
                  <button key={p.id} onClick={() => togglePlatform(p.id)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                      padding: '0.5rem 0.85rem', borderRadius: '999px', cursor: 'pointer',
                      border: `1px solid ${active ? p.color : 'var(--border-color)'}`,
                      background: active ? `${p.color}22` : 'transparent',
                      color: active ? p.color : 'var(--text-secondary)',
                      fontWeight: 600, fontSize: '0.85rem',
                    }}>
                    <Icon size={14} /> {p.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.5rem', fontWeight: 600 }}>
              Content
            </label>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder="What do you want to share?"
              rows={6}
              style={{
                width: '100%', padding: '0.75rem', borderRadius: '8px',
                background: 'var(--bg-glass)', border: '1px solid var(--border-color)',
                color: 'var(--text-primary)', resize: 'vertical', fontSize: '0.9rem', fontFamily: 'inherit',
              }}
            />
            <div style={{ marginTop: '0.4rem', fontSize: '0.75rem', color: overLimit ? '#ef4444' : 'var(--text-secondary)', textAlign: 'right' }}>
              {content.length} / {charLimit}
            </div>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.5rem', fontWeight: 600 }}>
              Media URL (optional)
            </label>
            <input
              type="url" value={mediaUrl} onChange={e => setMediaUrl(e.target.value)}
              placeholder="https://example.com/image.jpg"
              style={{
                width: '100%', padding: '0.6rem', borderRadius: '8px',
                background: 'var(--bg-glass)', border: '1px solid var(--border-color)', color: 'var(--text-primary)',
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem' }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.5rem', fontWeight: 600 }}>
                <Calendar size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Schedule date
              </label>
              <input type="date" value={scheduleDate} onChange={e => setScheduleDate(e.target.value)}
                style={{ width: '100%', padding: '0.6rem', borderRadius: '8px',
                  background: 'var(--bg-glass)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}/>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.5rem', fontWeight: 600 }}>Time</label>
              <input type="time" value={scheduleTime} onChange={e => setScheduleTime(e.target.value)}
                style={{ width: '100%', padding: '0.6rem', borderRadius: '8px',
                  background: 'var(--bg-glass)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}/>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
            <button className="btn-secondary" disabled={busy || !scheduleDate} onClick={() => submitPost(false)}>
              <Calendar size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Schedule
            </button>
            <button className="btn-primary" disabled={busy} onClick={() => submitPost(true)}>
              <Send size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Publish Now
            </button>
          </div>
        </div>
      )}

      {/* SCHEDULED */}
      {tab === 'scheduled' && (
        <div>
          {scheduledPosts.length === 0 ? (
            <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
              <Calendar size={36} style={{ opacity: 0.4, marginBottom: '0.75rem' }} />
              <p>No scheduled or draft posts.</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {scheduledPosts.map(p => {
                const pm = platformMeta(p.platform);
                const Icon = pm.icon;
                const sc = STATUS_COLORS[p.status] || STATUS_COLORS.DRAFT;
                return (
                  <div key={p.id} className="card" style={{ padding: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                        <Icon size={14} style={{ color: pm.color }} />
                        <span style={{ fontWeight: 600, color: pm.color }}>{pm.name}</span>
                        <span style={{
                          padding: '0.15rem 0.5rem', borderRadius: '999px', fontSize: '0.7rem',
                          background: sc.bg, color: sc.color, fontWeight: 600,
                        }}>
                          {p.status}
                        </span>
                        {p.scheduledFor && (
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                            <Calendar size={11} style={{ verticalAlign: 'middle' }} /> {new Date(p.scheduledFor).toLocaleString()}
                          </span>
                        )}
                      </div>
                      <p style={{ fontSize: '0.9rem', whiteSpace: 'pre-wrap' }}>{p.content}</p>
                      {p.mediaUrl && (
                        <a href={p.mediaUrl} target="_blank" rel="noreferrer" style={{ fontSize: '0.75rem', color: 'var(--accent-color)' }}>
                          <LinkIcon size={11} style={{ verticalAlign: 'middle' }} /> {p.mediaUrl}
                        </a>
                      )}
                    </div>
                    <button onClick={() => cancelScheduled(p.id)} title="Cancel"
                      style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer' }}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* MENTIONS */}
      {tab === 'mentions' && (
        <div>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
            {PLATFORMS.map(p => {
              const Icon = p.icon;
              return (
                <button key={p.id} className="btn-secondary" disabled={busy} onClick={() => fetchMentionsFor(p.id)}>
                  <RefreshCw size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                  <Icon size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Fetch {p.name}
                </button>
              );
            })}
          </div>
          {mentions.length === 0 ? (
            <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
              <AtSign size={36} style={{ opacity: 0.4, marginBottom: '0.75rem' }} />
              <p>No mentions yet. Use the buttons above to fetch sample mentions.</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {mentions.map(m => {
                const pm = platformMeta(m.platform);
                const Icon = pm.icon;
                const sentColor = SENTIMENT_COLORS[m.sentiment] || '#888';
                return (
                  <div key={m.id} className="card" style={{ padding: '1rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <Icon size={14} style={{ color: pm.color }} />
                        <strong>{m.authorName || 'Unknown'}</strong>
                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{m.authorHandle}</span>
                        {m.sentiment && (
                          <span style={{
                            padding: '0.15rem 0.5rem', borderRadius: '999px', fontSize: '0.7rem',
                            background: `${sentColor}22`, color: sentColor, fontWeight: 600,
                          }}>
                            {m.sentiment}
                          </span>
                        )}
                      </div>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        {new Date(m.fetchedAt).toLocaleString()}
                      </span>
                    </div>
                    <p style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>{m.content}</p>
                    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', fontSize: '0.8rem' }}>
                      {m.url && (
                        <a href={m.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-color)' }}>
                          <LinkIcon size={11} style={{ verticalAlign: 'middle' }} /> View
                        </a>
                      )}
                      {m.contactId ? (
                        <span style={{ color: '#10b981' }}>
                          <Check size={11} style={{ verticalAlign: 'middle' }} /> Linked to contact #{m.contactId}
                        </span>
                      ) : (
                        <button onClick={() => linkMentionToContact(m.id)}
                          style={{ background: 'transparent', border: 'none', color: 'var(--accent-color)', cursor: 'pointer', fontSize: '0.8rem' }}>
                          <LinkIcon size={11} style={{ verticalAlign: 'middle', marginRight: 3 }} /> Link to Contact
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ACCOUNTS */}
      {tab === 'accounts' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
          {PLATFORMS.map(p => {
            const acc = accounts.find(a => a.platform === p.id) || { connected: false };
            const Icon = p.icon;
            return (
              <div key={p.id} className="card" style={{ padding: '1.25rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                  <Icon size={20} style={{ color: p.color }} />
                  <h4 style={{ margin: 0 }}>{p.name}</h4>
                  <span style={{
                    marginLeft: 'auto', padding: '0.2rem 0.5rem', borderRadius: '999px', fontSize: '0.7rem',
                    background: acc.connected ? 'rgba(16,185,129,0.15)' : 'rgba(107,114,128,0.15)',
                    color: acc.connected ? '#10b981' : '#6b7280', fontWeight: 600,
                  }}>
                    {acc.connected ? 'Connected' : 'Disconnected'}
                  </span>
                </div>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
                  {acc.connected
                    ? `Active. Last updated ${acc.updatedAt ? new Date(acc.updatedAt).toLocaleDateString() : ''}`
                    : `Connect your ${p.name} account to publish posts and monitor mentions.`}
                </p>
                {acc.connected ? (
                  <button className="btn-secondary" onClick={() => disconnect(p.id)} style={{ width: '100%' }}>
                    <X size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Disconnect
                  </button>
                ) : (
                  <button className="btn-primary" onClick={() => setConnectModal(p.id)} style={{ width: '100%' }}>
                    <Settings size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Connect
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* CONNECT MODAL */}
      {connectModal && (
        <div onClick={() => setConnectModal(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div onClick={e => e.stopPropagation()} className="card"
            style={{ padding: '1.5rem', width: '90%', maxWidth: 480, background: 'var(--bg-card)' }}>
            <h3 style={{ marginBottom: '1rem' }}>Connect {platformMeta(connectModal).name}</h3>
            <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.4rem' }}>Access Token</label>
            <input type="text" value={connectToken} onChange={e => setConnectToken(e.target.value)}
              placeholder="Paste OAuth access token"
              style={{ width: '100%', padding: '0.6rem', borderRadius: '8px', marginBottom: '0.75rem',
                background: 'var(--bg-glass)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }} />
            {connectModal === 'twitter' && (
              <>
                <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.4rem' }}>Access Secret (optional)</label>
                <input type="text" value={connectSecret} onChange={e => setConnectSecret(e.target.value)}
                  placeholder="OAuth 1.0a access secret"
                  style={{ width: '100%', padding: '0.6rem', borderRadius: '8px', marginBottom: '0.75rem',
                    background: 'var(--bg-glass)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }} />
              </>
            )}
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button className="btn-secondary" onClick={() => setConnectModal(null)}>Cancel</button>
              <button className="btn-primary" onClick={submitConnect}>Connect</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
