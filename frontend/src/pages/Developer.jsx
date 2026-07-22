import React, { useState, useEffect, useContext, useCallback } from 'react';
import { Key, Globe, Plus, Trash2, Copy, CheckCircle2, Activity, ShieldCheck, ShieldAlert, RefreshCw } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { AuthContext } from '../App';
import TopScrollSync from '../components/TopScrollSync';

// #899 — Travel-vertical sub-brand options for API key scoping. Mirrors the
// VALID_API_KEY_SUB_BRANDS list in backend/routes/developer.js.
const TRAVEL_SUB_BRANDS = [
  { value: '', label: 'Tenant-wide (all sub-brands)' },
  { value: 'tmc', label: 'TMC (School trips)' },
  { value: 'rfu', label: 'RFU (Umrah)' },
  { value: 'travelstall', label: 'Travel Stall (Family)' },
  { value: 'visasure', label: 'Visa Sure' },
];

// #899 — webhook event catalogue: original 3 + 5 added in ticks #36-#41 + #47.
// Backend emits via backend/lib/eventBus.js (see safeEmitEvent + canonical
// catalogue JSDoc); subscribers receive via webhookDelivery.js.
const WEBHOOK_EVENTS = [
  { value: 'deal.created', label: 'Deal Created' },
  { value: 'deal.won', label: 'Deal Won' },
  { value: 'contact.created', label: 'Contact Created' },
  { value: 'invoice.created', label: 'Invoice Created' },
  { value: 'payment.collected', label: 'Payment Collected' },
  { value: 'quote.sent', label: 'Quote Sent' },
  { value: 'itinerary.accepted', label: 'Itinerary Accepted' },
  { value: 'visa.status_changed', label: 'Visa Status Changed' },
];

export default function Developer() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isTravelTenant = user?.tenant?.vertical === 'travel';
  const [keys, setKeys] = useState([]);
  const [hooks, setHooks] = useState([]);
  const [copiedId, setCopiedId] = useState(null);
  // Agent activity feed — populated from /api/developer/agent-activity
  // every 3s. Empty when no agents have logged anything yet.
  const [agentActivity, setAgentActivity] = useState([]);
  const [agentActivityErr, setAgentActivityErr] = useState(null);

  const [newKeyName, setNewKeyName] = useState('');
  // #899 — empty string = tenant-wide; 'tmc'|'rfu'|'travelstall'|'visasure'
  // = scoped. Only the sub-brand-scoped variant matters on travel tenants.
  const [newKeySubBrand, setNewKeySubBrand] = useState('');
  const [newHook, setNewHook] = useState({ event: 'deal.created', targetUrl: '' });

  // ── S121 — CSP Violations observability surface ───────────────────────
  // Operators check this card BEFORE flipping CSP_ENFORCE=1 in production
  // env vars. The green "safe to enforce" badge needs to be stable for
  // 24h before the env-var change is considered safe.
  const [cspViolations, setCspViolations] = useState([]);
  const [cspClean24h, setCspClean24h] = useState(false);
  const [cspSinceIso, setCspSinceIso] = useState(null);
  const [cspLoading, setCspLoading] = useState(false);
  const [cspError, setCspError] = useState(null);

  const loadCspViolations = useCallback(async () => {
    setCspLoading(true);
    setCspError(null);
    try {
      const r = await fetchApi('/api/security/violations?limit=100');
      setCspViolations(Array.isArray(r?.violations) ? r.violations : []);
      setCspClean24h(Boolean(r?.clean24h));
      setCspSinceIso(r?.sinceIso || null);
    } catch (err) {
      setCspError(err?.message || 'Failed to load CSP violations');
    } finally {
      setCspLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDevData();
  }, []);

  // S121 — load CSP violations once on mount. Refresh button drives re-fetch.
  useEffect(() => {
    loadCspViolations();
  }, [loadCspViolations]);

  // Poll the agent-activity log every 3s. Cleans up on unmount.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetchApi('/api/developer/agent-activity?limit=50');
        if (!cancelled) {
          setAgentActivity(Array.isArray(r?.activity) ? r.activity : []);
          setAgentActivityErr(null);
        }
      } catch (err) {
        if (!cancelled) setAgentActivityErr(err.message || 'failed to fetch agent activity');
      }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const loadDevData = async () => {
    try {
      const k = await fetchApi('/api/developer/apikeys');
      setKeys(Array.isArray(k) ? k : []);

      const h = await fetchApi('/api/developer/webhooks');
      setHooks(Array.isArray(h) ? h : []);
    } catch (err) {
      console.error(err);
    }
  };

  const generateKey = async (e) => {
    e.preventDefault();
    // #720: defense-in-depth — backend rejects empty / whitespace-only names
    // with 400 KEY_NAME_REQUIRED, but we also block at the client so the
    // common case (user hits Enter on a blank field, browser autofill
    // races) produces an inline notify rather than a network round-trip.
    const trimmed = newKeyName.trim();
    if (!trimmed) {
      notify.error("Key name is required.");
      return;
    }
    try {
      // #899 — send subBrand only when set + on travel tenants; backend
      // validates against the whitelist and rejects unknown values 400.
      const body = { name: trimmed };
      if (isTravelTenant && newKeySubBrand) body.subBrand = newKeySubBrand;
      const { rawKey } = await fetchApi('/api/developer/apikeys', { method: 'POST', body: JSON.stringify(body) });
      notify.success(`ATTENTION: This is the ONLY time this key will be displayed.\n\nSave this in a secure vault immediately:\n\n${rawKey}`, { ttl: 30000 });
      setNewKeyName('');
      setNewKeySubBrand('');
      loadDevData();
    } catch(err) {
      notify.error("Failed to create key.");
    }
  };

  const deleteKey = async (id) => {
    if (await notify.confirm("WARNING: Revoking this API Key will immediately sever all integrations relying upon it. Proceed?")) {
      await fetchApi(`/api/developer/apikeys/${id}`, { method: 'DELETE' });
      loadDevData();
    }
  };

  const registerWebhook = async (e) => {
    e.preventDefault();
    if (!newHook.targetUrl) return;
    try {
      await fetchApi('/api/developer/webhooks', { method: 'POST', body: JSON.stringify(newHook) });
      setNewHook({ event: 'deal.created', targetUrl: '' });
      loadDevData();
    } catch(err) {
      notify.error("Failed to register webhook");
    }
  };

  const deleteWebhook = async (id) => {
    await fetchApi(`/api/developer/webhooks/${id}`, { method: 'DELETE' });
    loadDevData();
  };

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold' }}>Developer Ecosystem</h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>REST Extensibility, Bearer API Keys, and Outbound Webhook Streams.</p>
        </div>
      </header>

      {/* Agent activity feed — live tail of background agents the
          orchestrator parent has dispatched. Polls /api/developer/
          agent-activity every 3 seconds. Empty when no agents have
          logged anything (most users will see this).
          See .claude/skills/reporting-agent-progress/SKILL.md for the
          contract agents follow when posting entries. */}
      <div className="card" style={{ padding: '1.5rem', marginBottom: '2rem' }}>
        <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Activity size={18} color="var(--accent-color)" /> Live agent activity
          <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 'normal' }}>
            polling every 3s · {agentActivity.length} {agentActivity.length === 1 ? 'entry' : 'entries'}
          </span>
        </h3>
        {agentActivityErr && (
          <p style={{ fontSize: '0.85rem', color: '#ef4444', marginBottom: '0.5rem' }}>
            Couldn't reach the agent-activity log: {agentActivityErr}
          </p>
        )}
        {agentActivity.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: 0 }}>
            No agent activity yet. Dispatched agents append entries here as they progress —
            you'll see start, milestone, and finish events with file paths + commit hashes
            as they land.
          </p>
        ) : (
          <div style={{ maxHeight: 320, overflowY: 'auto', fontSize: '0.85rem', fontFamily: 'monospace' }}>
            <TopScrollSync>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--surface-color, #fff)' }}>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color, #e5e7eb)' }}>
                  <th style={{ padding: '0.4rem 0.5rem', fontWeight: 600 }}>Time</th>
                  <th style={{ padding: '0.4rem 0.5rem', fontWeight: 600 }}>Agent</th>
                  <th style={{ padding: '0.4rem 0.5rem', fontWeight: 600 }}>Action</th>
                  <th style={{ padding: '0.4rem 0.5rem', fontWeight: 600 }}>Detail</th>
                </tr>
              </thead>
              <tbody>
                {agentActivity.map((row, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.05))' }}>
                    <td style={{ padding: '0.35rem 0.5rem', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                      {row.ts ? new Date(row.ts).toLocaleTimeString() : '?'}
                    </td>
                    <td style={{ padding: '0.35rem 0.5rem', whiteSpace: 'nowrap' }}>
                      <strong>{row.agent}</strong>
                    </td>
                    <td style={{ padding: '0.35rem 0.5rem', whiteSpace: 'nowrap' }}>
                      <span style={{
                        display: 'inline-block',
                        padding: '0.1rem 0.5rem',
                        borderRadius: 4,
                        background: row.status === 'done' ? 'rgba(16,185,129,0.15)' : row.status === 'failed' ? 'rgba(239,68,68,0.15)' : 'rgba(59,130,246,0.15)',
                        color: row.status === 'done' ? '#10b981' : row.status === 'failed' ? '#ef4444' : '#3b82f6',
                      }}>
                        {row.action}
                      </span>
                    </td>
                    <td style={{ padding: '0.35rem 0.5rem' }}>
                      {row.file && <span style={{ color: 'var(--text-secondary)' }}>{row.file}</span>}
                      {row.file && row.message && ' · '}
                      {row.message}
                      {row.commit && (
                        <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: 'var(--accent-color)' }}>
                          [{row.commit.slice(0, 7)}]
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </TopScrollSync>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>

        {/* API Keys */}
        <div className="card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Key size={20} color="var(--accent-color)" /> API Credentials
          </h3>
          <form onSubmit={generateKey} style={{ display: 'flex', gap: '1rem', marginBottom: '2rem', flexWrap: 'wrap' }}>
            {/* #720: required attribute triggers the browser-native validity
                tooltip on submit + disables the Generate Key button via the
                form's :invalid state, so an empty-name submission never even
                reaches the JS handler. The handler's trim()-check is the
                second layer (defends against whitespace-only names). */}
            <input
              type="text"
              className="input-field"
              style={{ margin: 0, flex: 1, minWidth: 200 }}
              placeholder="Key Name (e.g. Zapier Integration)"
              required
              minLength={1}
              value={newKeyName}
              onChange={e => setNewKeyName(e.target.value)}
            />
            {/* #899 — sub-brand scoping selector (travel-vertical only).
                Backend validates against the whitelist; null/empty = tenant-wide
                (legacy / generic). Scoped keys can only push to their named
                sub-brand via voyagrAuth's requireSubBrandMatch helper. */}
            {isTravelTenant && (
              <select
                className="input-field"
                style={{ margin: 0, minWidth: 220 }}
                value={newKeySubBrand}
                onChange={e => setNewKeySubBrand(e.target.value)}
                aria-label="Sub-brand scope"
              >
                {TRAVEL_SUB_BRANDS.map(b => (
                  <option key={b.value || 'all'} value={b.value}>{b.label}</option>
                ))}
              </select>
            )}
            <button className="btn-primary" type="submit" disabled={!newKeyName.trim()}>Generate Key</button>
          </form>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {keys.map(k => (
              <div key={k.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1.25rem', background: 'var(--subtle-bg-2)', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                <div>
                  <h4 style={{ fontWeight: '600', fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                    {k.name}
                    {/* #899 — render sub-brand badge when the key is scoped.
                        Tenant-wide keys (subBrand=null) show no badge. */}
                    {k.subBrand && (
                      <span style={{ fontSize: '0.7rem', padding: '0.15rem 0.5rem', borderRadius: 10, background: 'rgba(59,130,246,0.12)', color: 'var(--accent-color)', fontWeight: 600 }} title={`Scoped to sub-brand: ${k.subBrand}`}>
                        {k.subBrand}
                      </span>
                    )}
                  </h4>
                  <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', fontFamily: 'monospace', letterSpacing: '0.1em', marginTop: '0.25rem' }}>{k.keySecret.substring(0, 10)}****************</p>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(k.keySecret);
                      setCopiedId(k.id);
                      setTimeout(() => setCopiedId(null), 2000);
                    }}
                    title="Copy to Clipboard"
                    style={{ background: 'transparent', border: 'none', color: copiedId === k.id ? 'var(--success-color)' : 'var(--accent-color)', cursor: 'pointer' }}
                  >
                    {copiedId === k.id ? <CheckCircle2 size={18} /> : <Copy size={18} />}
                  </button>
                  <button onClick={() => deleteKey(k.id)} style={{ background: 'transparent', border: 'none', color: 'var(--danger-color)', cursor: 'pointer' }}>
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>
            ))}
            {keys.length === 0 && <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', padding: '1rem', background: 'var(--subtle-bg)', borderRadius: '8px', textAlign: 'center' }}>No active API keys located.</p>}
          </div>
        </div>

        {/* Webhooks */}
        <div className="card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Globe size={20} color="var(--success-color)" /> Webhooks
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
            Configure HTTP POST endpoints to receive real-time JSON payloads when state changes occur.
          </p>

          <form onSubmit={registerWebhook} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '2rem' }}>
            <div style={{ display: 'flex', gap: '1rem' }}>
              {/* #899 — webhook event catalogue expanded from the original 3
                  to include the 5 lifecycle events added in ticks #36-#41 +
                  #47 (Invoice Created, Payment Collected, Quote Sent,
                  Itinerary Accepted, Visa Status Changed). Backend emits via
                  backend/lib/eventBus.js → webhookDelivery.js. */}
              <select className="input-field" style={{ margin: 0, width: '220px', background: 'var(--input-bg)' }} value={newHook.event} onChange={e => setNewHook({ ...newHook, event: e.target.value })}>
                {WEBHOOK_EVENTS.map(ev => (
                  <option key={ev.value} value={ev.value}>{ev.label}</option>
                ))}
              </select>
              <input type="url" className="input-field" style={{ margin: 0, flex: 1 }} placeholder="https://endpoint.example.com/webhook" required value={newHook.targetUrl} onChange={e => setNewHook({ ...newHook, targetUrl: e.target.value })} />
            </div>
            <button className="btn-secondary" type="submit" style={{ width: '100%' }}>Register Target Endpoint</button>
          </form>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {hooks.map(h => (
              <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1.25rem', background: 'var(--subtle-bg-2)', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                <div>
                  <h4 style={{ fontWeight: '600', fontSize: '1rem', color: 'var(--success-color)', display: 'inline-block', padding: '0.25rem 0.5rem', background: 'rgba(16, 185, 129, 0.1)', borderRadius: '4px' }}>{h.event}</h4>
                  <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginTop: '0.75rem' }}>POST: {h.targetUrl}</p>
                </div>
                <button onClick={() => deleteWebhook(h.id)} style={{ background: 'transparent', border: 'none', color: 'var(--danger-color)', cursor: 'pointer' }}>
                  <Trash2 size={18} />
                </button>
              </div>
            ))}
            {hooks.length === 0 && <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', padding: '1rem', background: 'var(--subtle-bg)', borderRadius: '8px', textAlign: 'center' }}>No registered webhook listeners.</p>}
          </div>
        </div>

      </div>

      {/* S121 — CSP Violations observability card.
          Lists recent AuditLog rows where entity='CSPViolation' (written by
          backend/routes/csp.js POST /report) so operators can visually
          verify "24h of clean Report-Only logs" BEFORE setting CSP_ENFORCE=1
          in production env vars. Without this surface, the only way to
          check was SSH-into-demo + raw Prisma query.

          See backend/middleware/security.js for the S117 env-gated
          helmetStrictReportOnlyMiddleware that reads CSP_ENFORCE and
          swaps the response header from CSP-Report-Only → CSP. */}
      <div className="card" style={{ padding: '1.5rem', marginTop: '2rem' }}>
        <h3 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {cspClean24h
            ? <ShieldCheck size={20} color="var(--success-color, #10b981)" />
            : <ShieldAlert size={20} color="var(--danger-color, #ef4444)" />}
          CSP Violations
          <button
            onClick={loadCspViolations}
            disabled={cspLoading}
            title="Refresh"
            aria-label="Refresh CSP violations"
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: '1px solid var(--border-color, #e5e7eb)',
              borderRadius: 6,
              padding: '0.25rem 0.6rem',
              cursor: cspLoading ? 'not-allowed' : 'pointer',
              color: 'var(--text-secondary)',
              fontSize: '0.85rem',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
            }}
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </h3>

        {/* go/no-go badge — green when clean24h===true, red when violations
            in the last 24h. Operators check this card before flipping
            CSP_ENFORCE=1 in production. */}
        <div
          role="status"
          style={{
            padding: '0.75rem 1rem',
            borderRadius: 6,
            marginBottom: '1rem',
            fontSize: '0.9rem',
            fontWeight: 500,
            background: cspClean24h ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)',
            color: cspClean24h ? 'var(--success-color, #10b981)' : 'var(--danger-color, #ef4444)',
            border: `1px solid ${cspClean24h ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`,
          }}
        >
          {cspClean24h
            ? 'CSP-clean (24h) — safe to enforce'
            : `${cspViolations.length} violation${cspViolations.length === 1 ? '' : 's'} in last 24h — DO NOT flip CSP_ENFORCE yet`}
        </div>

        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          Set <code style={{ background: 'var(--subtle-bg)', padding: '0.1rem 0.35rem', borderRadius: 3 }}>CSP_ENFORCE=1</code> in production env vars after 24h of green-badge state to switch CSP from Report-Only to enforce mode.
        </p>

        {cspError && (
          <p style={{ fontSize: '0.85rem', color: 'var(--danger-color, #ef4444)', marginBottom: '0.75rem' }}>
            Couldn't load CSP violations: {cspError}
          </p>
        )}

        {cspViolations.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', padding: '0.75rem', background: 'var(--subtle-bg)', borderRadius: 6, textAlign: 'center' }}>
            No CSP violations in the selected window.
          </p>
        ) : (
          <div style={{ maxHeight: 320, overflowY: 'auto', fontSize: '0.85rem' }}>
            <TopScrollSync>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--surface-color, #fff)' }}>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color, #e5e7eb)' }}>
                  <th style={{ padding: '0.4rem 0.5rem', fontWeight: 600 }}>Time</th>
                  <th style={{ padding: '0.4rem 0.5rem', fontWeight: 600 }}>Directive</th>
                  <th style={{ padding: '0.4rem 0.5rem', fontWeight: 600 }}>Blocked URI</th>
                  <th style={{ padding: '0.4rem 0.5rem', fontWeight: 600 }}>Document URI</th>
                  <th style={{ padding: '0.4rem 0.5rem', fontWeight: 600 }}>Source</th>
                </tr>
              </thead>
              <tbody>
                {cspViolations.map((row, i) => {
                  // Parse the AuditLog details JSON. The csp.js POST /report
                  // handler writes the raw browser report into the `details`
                  // column as a JSON string. Tolerate parse errors gracefully.
                  let parsed = null;
                  try {
                    parsed = row.details ? JSON.parse(row.details) : null;
                  } catch (_) {
                    parsed = null;
                  }
                  // The W3C shape nests under `csp-report`; the Reporting-API
                  // shape is a top-level array; plain JSON uses dotted keys.
                  const report = parsed?.['csp-report'] || (Array.isArray(parsed) ? parsed[0]?.body : null) || parsed || {};
                  const directive = report['effective-directive'] || report['violated-directive'] || report.effectiveDirective || report.violatedDirective || '—';
                  const blockedUri = report['blocked-uri'] || report.blockedURL || '—';
                  const documentUri = report['document-uri'] || report.documentURL || '—';
                  const sourceFile = report['source-file'] || report.sourceFile || '';
                  const lineNumber = report['line-number'] || report.lineNumber || '';
                  const sourceCell = sourceFile ? `${sourceFile}${lineNumber ? `:${lineNumber}` : ''}` : '—';

                  return (
                    <tr key={row.id || i} style={{ borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.05))' }}>
                      <td style={{ padding: '0.35rem 0.5rem', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                        {row.createdAt ? new Date(row.createdAt).toLocaleString() : '?'}
                      </td>
                      <td style={{ padding: '0.35rem 0.5rem', fontFamily: 'monospace' }}>
                        {directive}
                      </td>
                      <td style={{ padding: '0.35rem 0.5rem', fontFamily: 'monospace', wordBreak: 'break-all', maxWidth: 220 }}>
                        {blockedUri}
                      </td>
                      <td style={{ padding: '0.35rem 0.5rem', fontFamily: 'monospace', wordBreak: 'break-all', maxWidth: 220 }}>
                        {documentUri}
                      </td>
                      <td style={{ padding: '0.35rem 0.5rem', fontFamily: 'monospace', wordBreak: 'break-all', maxWidth: 200 }}>
                        {sourceCell}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </TopScrollSync>
          </div>
        )}

        {cspSinceIso && (
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.75rem', textAlign: 'right' }}>
            Window since: {new Date(cspSinceIso).toLocaleString()}
          </p>
        )}
      </div>
    </div>
  );
}
