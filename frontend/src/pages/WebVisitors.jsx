import React, { useEffect, useMemo, useState } from 'react';
import { Eye, Globe, Users, UserCheck, Calendar, Copy, ChevronDown, ChevronRight } from 'lucide-react';
import { fetchApi, getAuthToken } from '../utils/api';

function timeAgo(d) {
  if (!d) return '';
  const ms = Date.now() - new Date(d).getTime();
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const days = Math.floor(h / 24);
  return days + 'd ago';
}

function shortHost(url) {
  if (!url) return '';
  try { return new URL(url).pathname || '/'; } catch { return url; }
}

function StatCard({ icon: Icon, label, value, accent }) {
  return (
    <div className="card" style={{ padding: '1.25rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
      <div style={{
        width: 44, height: 44, borderRadius: 10,
        background: accent || 'rgba(99,102,241,0.15)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#6366f1',
      }}>
        <Icon size={22} />
      </div>
      <div>
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{label}</div>
        <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>{value}</div>
      </div>
    </div>
  );
}

export default function WebVisitors() {
  const [stats, setStats] = useState({ today: 0, week: 0, month: 0, identified: 0, total: 0, pctIdentified: 0 });
  const [visitors, setVisitors] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [details, setDetails] = useState({});
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const tenantId = useMemo(() => {
    try {
      const tok = getAuthToken();
      if (!tok) return 1;
      const payload = JSON.parse(atob(tok.split('.')[1] || ''));
      return payload.tenantId || 1;
    } catch { return 1; }
  }, []);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const snippet = `<script src="${origin}/crm-track.js" data-tenant="${tenantId}"></script>`;

  const load = async () => {
    setLoading(true);
    try {
      const [s, v] = await Promise.all([
        fetchApi('/api/web-visitors/stats').catch(() => null),
        fetchApi('/api/web-visitors').catch(() => []),
      ]);
      if (s) setStats(s);
      setVisitors(Array.isArray(v) ? v : []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const toggleRow = async (id) => {
    setExpanded(e => ({ ...e, [id]: !e[id] }));
    if (!details[id]) {
      try {
        const d = await fetchApi(`/api/web-visitors/${id}`);
        setDetails(prev => ({ ...prev, [id]: d }));
      } catch { /* ignore */ }
    }
  };

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = snippet; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
      document.body.removeChild(ta);
    }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Eye size={26} style={{ color: 'var(--accent-color, #6366f1)' }} />
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>Web Visitors</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', margin: 0 }}>
              See who's browsing your site in real time
            </p>
          </div>
        </div>
        <button className="btn-secondary" onClick={load}>Refresh</button>
      </header>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
        <StatCard icon={Calendar} label="Today" value={stats.today} accent="rgba(59,130,246,0.15)" />
        <StatCard icon={Users} label="Last 7 days" value={stats.week} accent="rgba(16,185,129,0.15)" />
        <StatCard icon={Globe} label="Last 30 days" value={stats.month} accent="rgba(245,158,11,0.15)" />
        <StatCard icon={UserCheck} label="% Identified" value={`${stats.pctIdentified || 0}%`} accent="rgba(139,92,246,0.15)" />
      </div>

      {/* Visitor table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: '1.5rem' }}>
        <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.08))' }}>
          <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Recent Visitors (last 7 days)</h3>
        </div>
        {loading ? (
          <div style={{ padding: '2.5rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading visitors...</div>
        ) : visitors.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            <Eye size={42} style={{ opacity: 0.3, marginBottom: '0.75rem' }} />
            <div>No visitors tracked yet. Install the snippet below on your site.</div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)', textAlign: 'left' }}>
                  <th style={th}></th>
                  <th style={th}>Visitor</th>
                  <th style={th}>Country</th>
                  <th style={th}>Pages</th>
                  <th style={th}>Last Page</th>
                  <th style={th}>Last Seen</th>
                </tr>
              </thead>
              <tbody>
                {visitors.map(v => {
                  const open = !!expanded[v.id];
                  const detail = details[v.id];
                  const label = v.contact ? (v.contact.name || v.contact.email) : `Anonymous · ${v.sessionId.slice(0, 8)}`;
                  return (
                    <React.Fragment key={v.id}>
                      <tr
                        style={{ borderTop: '1px solid var(--border-color, rgba(255,255,255,0.06))', cursor: 'pointer' }}
                        onClick={() => toggleRow(v.id)}
                      >
                        <td style={td}>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</td>
                        <td style={td}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <div style={{
                              width: 30, height: 30, borderRadius: '50%',
                              background: v.identified ? 'rgba(16,185,129,0.2)' : 'rgba(107,114,128,0.2)',
                              color: v.identified ? '#10b981' : '#9ca3af',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontWeight: 600, fontSize: '0.8rem',
                            }}>{(label || '?').slice(0, 1).toUpperCase()}</div>
                            <div>
                              <div style={{ fontWeight: 600 }}>{label}</div>
                              {v.contact && v.contact.email && (
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{v.contact.email}</div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td style={td}>{v.country || '—'}</td>
                        <td style={td}>{v.pageCount}</td>
                        <td style={{ ...td, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {shortHost(v.lastUrl) || '—'}
                        </td>
                        <td style={td}>{timeAgo(v.lastSeen)}</td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={6} style={{ padding: '1rem 1.5rem', background: 'rgba(255,255,255,0.02)' }}>
                            <div style={{ fontSize: '0.85rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>
                              Page history{v.userAgent ? ` · ${(v.userAgent || '').slice(0, 60)}…` : ''}
                            </div>
                            {!detail ? (
                              <div style={{ color: 'var(--text-secondary)' }}>Loading…</div>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: 220, overflowY: 'auto' }}>
                                {(detail.pages || []).slice().reverse().map((p, i) => (
                                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', fontSize: '0.85rem' }}>
                                    <span style={{ color: 'var(--text-primary)', wordBreak: 'break-all' }}>{p.url || '—'}</span>
                                    <span style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{timeAgo(p.timestamp)}</span>
                                  </div>
                                ))}
                                {(!detail.pages || detail.pages.length === 0) && (
                                  <div style={{ color: 'var(--text-secondary)' }}>No pages recorded.</div>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Embed snippet */}
      <div className="card" style={{ padding: '1.25rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Install Tracking Script</h3>
          <button className="btn-secondary" onClick={copySnippet} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Copy size={14} /> {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: 0, marginBottom: '0.75rem' }}>
          Paste this snippet just before <code>&lt;/body&gt;</code> on every page of your website.
        </p>
        <pre style={{
          background: 'rgba(0,0,0,0.4)', padding: '1rem', borderRadius: 8,
          color: '#a5b4fc', fontSize: '0.8rem', overflowX: 'auto', margin: 0,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}>{snippet}</pre>
        <div style={{ marginTop: '0.75rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
          Identify a visitor after sign-in: <code>window.crmTrack.identify('user@example.com')</code>
        </div>
      </div>
    </div>
  );
}

const th = { padding: '0.75rem 1rem', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' };
const td = { padding: '0.85rem 1rem', fontSize: '0.875rem', color: 'var(--text-primary)' };
