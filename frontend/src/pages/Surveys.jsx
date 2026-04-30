import React, { useState, useEffect } from 'react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { ClipboardList, Send, Plus, BarChart3, X, ArrowLeft, MessageSquare, Users } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell
} from 'recharts';

const TYPE_COLORS = {
  NPS: { bg: 'rgba(59,130,246,0.12)', color: '#3b82f6' },
  CSAT: { bg: 'rgba(16,185,129,0.12)', color: '#10b981' },
  CUSTOM: { bg: 'rgba(139,92,246,0.12)', color: '#8b5cf6' },
};

function TypeBadge({ type }) {
  const t = TYPE_COLORS[type] || TYPE_COLORS.CUSTOM;
  return (
    <span style={{
      padding: '0.2rem 0.6rem',
      borderRadius: '999px',
      fontSize: '0.7rem',
      fontWeight: 700,
      background: t.bg,
      color: t.color,
      letterSpacing: '0.04em',
    }}>{type}</span>
  );
}

function npsColor(score) {
  if (score === null || score === undefined) return 'var(--text-secondary)';
  if (score >= 50) return '#10b981';
  if (score >= 0) return '#f59e0b';
  return '#ef4444';
}

function avgColor(avg) {
  if (avg >= 7) return '#10b981';
  if (avg >= 4) return '#f59e0b';
  return '#ef4444';
}

export default function Surveys() {
  const notify = useNotify();
  const [surveys, setSurveys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', type: 'NPS', question: '' });
  const [submitting, setSubmitting] = useState(false);
  const [selected, setSelected] = useState(null); // survey object
  const [stats, setStats] = useState(null);
  const [responses, setResponses] = useState([]);
  const [showSendModal, setShowSendModal] = useState(false);
  const [contacts, setContacts] = useState([]);
  const [selectedContactIds, setSelectedContactIds] = useState([]);
  const [contactSearch, setContactSearch] = useState('');
  const [sending, setSending] = useState(false);
  const [sendMessage, setSendMessage] = useState('');

  const loadSurveys = async () => {
    setLoading(true);
    try {
      const data = await fetchApi('/api/surveys');
      setSurveys(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('Failed to load surveys', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadSurveys(); }, []);

  const openSurvey = async (s) => {
    setSelected(s);
    setStats(null);
    setResponses([]);
    try {
      const [st, rs] = await Promise.all([
        fetchApi(`/api/surveys/${s.id}/stats`),
        fetchApi(`/api/surveys/${s.id}/responses`),
      ]);
      setStats(st);
      setResponses(Array.isArray(rs) ? rs : []);
    } catch (e) {
      console.error('Failed to load survey detail', e);
    }
  };

  const closeSurvey = () => {
    setSelected(null);
    setStats(null);
    setResponses([]);
  };

  const createSurvey = async (e) => {
    e.preventDefault();
    if (!form.name.trim() || !form.question.trim()) return;
    setSubmitting(true);
    try {
      // #381: explicitly set isActive=true on creation so the survey is
      // immediately visible to the patient-facing wellness portal preview,
      // which filters by `isActive`. Without this flag the backend default
      // applies, but some downstream consumers (portal preview) were missing
      // surveys created before the default was added.
      await fetchApi('/api/surveys', {
        method: 'POST',
        body: JSON.stringify({ ...form, isActive: true }),
      });
      setShowCreate(false);
      setForm({ name: '', type: 'NPS', question: '' });
      await loadSurveys();
    } catch (err) {
      console.error('Failed to create survey', err);
    } finally {
      setSubmitting(false);
    }
  };

  const deleteSurvey = async (id, e) => {
    e.stopPropagation();
    if (!await notify.confirm('Delete this survey and all its responses?')) return;
    try {
      await fetchApi(`/api/surveys/${id}`, { method: 'DELETE' });
      await loadSurveys();
    } catch (err) {
      console.error('Delete failed', err);
    }
  };

  const openSendModal = async () => {
    setShowSendModal(true);
    setSelectedContactIds([]);
    setSendMessage('');
    setContactSearch('');
    try {
      const data = await fetchApi('/api/contacts');
      setContacts(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('Failed to load contacts', e);
    }
  };

  const toggleContact = (id) => {
    setSelectedContactIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const sendSurvey = async () => {
    if (!selected || selectedContactIds.length === 0) return;
    setSending(true);
    setSendMessage('');
    try {
      const res = await fetchApi(`/api/surveys/${selected.id}/send`, {
        method: 'POST',
        body: JSON.stringify({ contactIds: selectedContactIds }),
      });
      setSendMessage(`Sent to ${res.sentCount} of ${res.attempted || selectedContactIds.length} contacts.`);
      await loadSurveys();
    } catch (err) {
      console.error('Send failed', err);
      setSendMessage('Failed to send survey.');
    } finally {
      setSending(false);
    }
  };

  const filteredContacts = contacts.filter(c => {
    if (!contactSearch.trim()) return true;
    const q = contactSearch.toLowerCase();
    return (c.name || '').toLowerCase().includes(q) ||
           (c.email || '').toLowerCase().includes(q) ||
           (c.company || '').toLowerCase().includes(q);
  });

  // ── Detail view ──────────────────────────────────────────────
  if (selected) {
    const distData = (stats?.distribution || []).map((c, i) => ({ score: String(i), count: c }));
    return (
      <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.4s ease-out' }}>
        <button
          onClick={closeSurvey}
          className="btn-secondary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}
        >
          <ArrowLeft size={16} /> Back to Surveys
        </button>

        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' }}>
          <div>
            <h1 style={{ fontSize: '1.75rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <ClipboardList size={26} color="var(--accent-color)" /> {selected.name}
            </h1>
            <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
              <TypeBadge type={selected.type} /> &nbsp; {selected.question}
            </p>
          </div>
          <button onClick={openSendModal} className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
            <Send size={16} /> Send Survey
          </button>
        </header>

        {/* Stats summary */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1.25rem', marginBottom: '1.5rem' }}>
          <div className="card" style={{ padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Responses</span>
              <Users size={18} color="var(--accent-color)" />
            </div>
            <div style={{ fontSize: '2rem', fontWeight: 'bold' }}>{stats?.count ?? 0}</div>
          </div>
          <div className="card" style={{ padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Avg Score</span>
              <BarChart3 size={18} color="#f59e0b" />
            </div>
            <div style={{ fontSize: '2rem', fontWeight: 'bold', color: avgColor(stats?.avgScore || 0) }}>
              {(stats?.avgScore ?? 0).toFixed(2)}
            </div>
          </div>
          {selected.type === 'NPS' ? (
            <div className="card" style={{ padding: '1.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>NPS Score</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>-100 to +100</span>
              </div>
              <div style={{ fontSize: '2rem', fontWeight: 'bold', color: npsColor(stats?.npsScore) }}>
                {stats?.npsScore ?? 0}
              </div>
            </div>
          ) : (
            <div className="card" style={{ padding: '1.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Survey Type</span>
              </div>
              <div style={{ fontSize: '2rem', fontWeight: 'bold' }}>
                <TypeBadge type={selected.type} />
              </div>
            </div>
          )}
        </div>

        {/* Response form preview */}
        <div className="card" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
          <h3 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <MessageSquare size={18} color="var(--accent-color)" /> Response Form Preview
          </h3>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>{selected.question}</p>
          {selected.type === 'CSAT' ? (
            <div>
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', marginBottom: '0.5rem' }}>
                {[1, 2, 3, 4, 5].map(n => (
                  <button key={n} disabled style={{
                    width: '48px', height: '48px', borderRadius: '8px',
                    border: '1px solid var(--border-color)', background: 'var(--surface-color, rgba(255,255,255,0.04))',
                    color: 'var(--text-primary)', fontSize: '1rem', fontWeight: 600, cursor: 'not-allowed',
                  }}>{n}</button>
                ))}
              </div>
              {/* #380: anchor labels for the CSAT 1-5 scale */}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-secondary)', maxWidth: '280px', margin: '0 auto' }}>
                <span>Very Dissatisfied</span>
                <span>Very Satisfied</span>
              </div>
            </div>
          ) : selected.type === 'NPS' ? (
            <div>
              <div style={{ display: 'flex', gap: '0.35rem', justifyContent: 'center', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                  <button key={n} disabled style={{
                    width: '40px', height: '40px', borderRadius: '6px',
                    border: '1px solid var(--border-color)', background: 'var(--surface-color, rgba(255,255,255,0.04))',
                    color: 'var(--text-primary)', fontSize: '0.875rem', fontWeight: 600, cursor: 'not-allowed',
                  }}>{n}</button>
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                <span>Not at all likely</span>
                <span>Extremely likely</span>
              </div>
            </div>
          ) : (
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>Custom survey — free-form response.</p>
          )}
        </div>

        {/* Distribution chart */}
        <div className="card" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
          <h3 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <BarChart3 size={18} color="var(--accent-color)" /> Score Distribution
          </h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={distData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="score" tick={{ fontSize: 12, fill: 'var(--text-secondary)' }} />
              <YAxis tick={{ fontSize: 12, fill: 'var(--text-secondary)' }} allowDecimals={false} />
              <Tooltip
                contentStyle={{ background: 'var(--tooltip-bg)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-primary)' }}
                formatter={(v) => [`${v} responses`, 'Count']}
              />
              <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                {distData.map((entry, i) => {
                  const score = Number(entry.score);
                  const color = score >= 9 ? '#10b981' : score >= 7 ? '#f59e0b' : '#ef4444';
                  return <Cell key={i} fill={color} fillOpacity={0.85} />;
                })}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Responses table */}
        <div className="card" style={{ padding: '1.5rem' }}>
          <h3 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <MessageSquare size={18} color="var(--accent-color)" /> Recent Responses
          </h3>
          {responses.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>No responses yet. Send the survey to get started.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                    <th style={{ padding: '0.6rem 0.5rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Contact</th>
                    <th style={{ padding: '0.6rem 0.5rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Score</th>
                    <th style={{ padding: '0.6rem 0.5rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Comment</th>
                    <th style={{ padding: '0.6rem 0.5rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {responses.map(r => (
                    <tr key={r.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <td style={{ padding: '0.6rem 0.5rem' }}>
                        {r.contact ? (
                          <div>
                            <div style={{ fontWeight: 500 }}>{r.contact.name}</div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{r.contact.email}</div>
                          </div>
                        ) : (
                          <span style={{ color: 'var(--text-secondary)' }}>Anonymous</span>
                        )}
                      </td>
                      <td style={{ padding: '0.6rem 0.5rem' }}>
                        <span style={{
                          padding: '0.2rem 0.6rem',
                          borderRadius: '999px',
                          background: r.score >= 9 ? 'rgba(16,185,129,0.12)' : r.score >= 7 ? 'rgba(245,158,11,0.12)' : 'rgba(239,68,68,0.12)',
                          color: r.score >= 9 ? '#10b981' : r.score >= 7 ? '#f59e0b' : '#ef4444',
                          fontWeight: 600,
                        }}>{r.score}</span>
                      </td>
                      <td style={{ padding: '0.6rem 0.5rem', color: 'var(--text-secondary)', maxWidth: '320px' }}>
                        {r.comment || <em style={{ opacity: 0.6 }}>—</em>}
                      </td>
                      <td style={{ padding: '0.6rem 0.5rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {new Date(r.respondedAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Send modal */}
        {showSendModal && (
          <div style={modalOverlay} onClick={() => !sending && setShowSendModal(false)}>
            <div className="card" style={{ ...modalCard, width: 'min(620px, 92vw)' }} onClick={e => e.stopPropagation()}>
              <div style={modalHeader}>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Send size={18} /> Send "{selected.name}"
                </h3>
                <button onClick={() => setShowSendModal(false)} disabled={sending} style={iconBtn}><X size={18} /></button>
              </div>
              <input
                type="text"
                value={contactSearch}
                onChange={e => setContactSearch(e.target.value)}
                placeholder="Search contacts by name, email, or company..."
                style={inputStyle}
              />
              <div style={{
                maxHeight: '320px',
                overflowY: 'auto',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                marginTop: '0.75rem',
              }}>
                {filteredContacts.length === 0 ? (
                  <p style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.875rem', margin: 0 }}>No contacts found.</p>
                ) : filteredContacts.map(c => {
                  const checked = selectedContactIds.includes(c.id);
                  return (
                    <label key={c.id} style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.75rem',
                      padding: '0.6rem 0.85rem',
                      cursor: 'pointer',
                      borderBottom: '1px solid var(--border-color)',
                      background: checked ? 'rgba(59,130,246,0.08)' : 'transparent',
                    }}>
                      <input type="checkbox" checked={checked} onChange={() => toggleContact(c.id)} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 500 }}>{c.name || '(no name)'}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                          {c.email || 'no email'} {c.company ? `• ${c.company}` : ''}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
              <div style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                {selectedContactIds.length} selected
              </div>
              {sendMessage && (
                <div style={{
                  marginTop: '0.75rem',
                  padding: '0.6rem 0.9rem',
                  background: 'rgba(34,197,94,0.08)',
                  border: '1px solid rgba(34,197,94,0.2)',
                  borderRadius: '8px',
                  color: 'var(--success-color)',
                  fontSize: '0.85rem',
                }}>{sendMessage}</div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
                <button className="btn-secondary" onClick={() => setShowSendModal(false)} disabled={sending}>Close</button>
                <button
                  className="btn-primary"
                  onClick={sendSurvey}
                  disabled={sending || selectedContactIds.length === 0}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}
                >
                  <Send size={16} /> {sending ? 'Sending...' : `Send to ${selectedContactIds.length}`}
                </button>
              </div>
            </div>
          </div>
        )}

        <style>{`
          @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        `}</style>
      </div>
    );
  }

  // ── List view ────────────────────────────────────────────────
  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '2rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <ClipboardList size={28} color="var(--accent-color)" /> NPS/CSAT Surveys
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Measure customer satisfaction and loyalty with email-delivered surveys.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="btn-primary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}
        >
          <Plus size={16} /> Create Survey
        </button>
      </header>

      {loading ? (
        <p style={{ color: 'var(--text-secondary)' }}>Loading surveys...</p>
      ) : surveys.length === 0 ? (
        <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>
          <ClipboardList size={48} color="var(--text-secondary)" style={{ opacity: 0.5, marginBottom: '1rem' }} />
          <h3 style={{ fontWeight: 600, marginBottom: '0.5rem' }}>No surveys yet</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            Create your first NPS or CSAT survey to start collecting feedback.
          </p>
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '1.25rem',
        }}>
          {surveys.map(s => (
            <div
              key={s.id}
              className="card"
              onClick={() => openSurvey(s)}
              style={{ padding: '1.5rem', cursor: 'pointer', position: 'relative', transition: 'transform 0.15s' }}
              onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-2px)'}
              onMouseLeave={e => e.currentTarget.style.transform = 'translateY(0)'}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: '0.25rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.name}
                  </h3>
                  <TypeBadge type={s.type} />
                </div>
                <button
                  onClick={(e) => deleteSurvey(s.id, e)}
                  title="Delete"
                  style={{ ...iconBtn, color: 'var(--text-secondary)' }}
                >
                  <X size={16} />
                </button>
              </div>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1rem', minHeight: '2.5em' }}>
                {s.question}
              </p>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
                <div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Responses</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>{s.responseCount || 0}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  {s.type === 'NPS' ? (
                    <>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>NPS</div>
                      <div style={{ fontSize: '1.25rem', fontWeight: 700, color: npsColor(s.npsScore) }}>
                        {s.responseCount ? (s.npsScore ?? 0) : '—'}
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Avg</div>
                      <div style={{ fontSize: '1.25rem', fontWeight: 700, color: avgColor(s.avgScore || 0) }}>
                        {s.responseCount ? (s.avgScore ?? 0).toFixed(1) : '—'}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <div style={modalOverlay} onClick={() => !submitting && setShowCreate(false)}>
          <form className="card" style={{ ...modalCard, width: 'min(520px, 92vw)' }} onClick={e => e.stopPropagation()} onSubmit={createSurvey}>
            <div style={modalHeader}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>Create Survey</h3>
              <button type="button" onClick={() => setShowCreate(false)} disabled={submitting} style={iconBtn}><X size={18} /></button>
            </div>
            <label style={labelStyle}>Name</label>
            <input
              type="text"
              required
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Q2 Customer Satisfaction"
              style={inputStyle}
            />
            <label style={labelStyle}>Type</label>
            <select
              value={form.type}
              onChange={e => setForm({ ...form, type: e.target.value })}
              style={inputStyle}
            >
              <option value="NPS">NPS — Net Promoter Score (0-10)</option>
              <option value="CSAT">CSAT — Customer Satisfaction</option>
              <option value="CUSTOM">Custom</option>
            </select>
            <label style={labelStyle}>Question</label>
            <textarea
              required
              value={form.question}
              onChange={e => setForm({ ...form, question: e.target.value })}
              placeholder="How likely are you to recommend us to a friend or colleague?"
              rows={3}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
              <button type="button" className="btn-secondary" onClick={() => setShowCreate(false)} disabled={submitting}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={submitting} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                <Plus size={16} /> {submitting ? 'Creating...' : 'Create Survey'}
              </button>
            </div>
          </form>
        </div>
      )}

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
      `}</style>
    </div>
  );
}

const modalOverlay = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.55)',
  backdropFilter: 'blur(4px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: '1rem',
};
const modalCard = {
  padding: '1.5rem',
  maxHeight: '90vh',
  overflowY: 'auto',
};
const modalHeader = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: '1rem',
};
const labelStyle = {
  display: 'block',
  fontSize: '0.8rem',
  color: 'var(--text-secondary)',
  marginTop: '0.75rem',
  marginBottom: '0.35rem',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};
const inputStyle = {
  width: '100%',
  padding: '0.6rem 0.8rem',
  background: 'var(--surface-color, rgba(255,255,255,0.04))',
  border: '1px solid var(--border-color)',
  borderRadius: '8px',
  color: 'var(--text-primary)',
  fontSize: '0.9rem',
  outline: 'none',
  boxSizing: 'border-box',
};
const iconBtn = {
  background: 'transparent',
  border: 'none',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  padding: '0.25rem',
  borderRadius: '4px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};
