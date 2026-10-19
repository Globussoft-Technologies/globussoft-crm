import { useCallback, useEffect, useState } from 'react';
import { fetchApi } from '../utils/api';

const templates = [
  { event: 'contact.created', title: 'New contact → Google Sheets row', action: 'Google Sheets / Create Spreadsheet Row', mapping: 'data.contactId, data.name, data.email, data.company' },
  { event: 'deal.won', title: 'Won deal → Slack notification', action: 'Slack / Send Channel Message', mapping: 'data.dealId, data.title, data.amount' },
  { event: 'task.completed', title: 'Completed task → team notification', action: 'Slack / Send Channel Message', mapping: 'data.taskId, data.contactId, data.completedAt' },
];

export default function ZapierSetup({ subscriptions, onChanged }) {
  const [connection, setConnection] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [hook, setHook] = useState('');
  const [event, setEvent] = useState('contact.created');
  const [result, setResult] = useState('');
  const refresh = useCallback(async () => {
    try { setConnection(await fetchApi('/api/zapier/connection')); setError(''); }
    catch { setConnection(null); setError('Unable to load connection status. Retry before assuming this integration is ready.'); }
  }, []);
  useEffect(() => { refresh(); }, [refresh, subscriptions]);
  const latest = connection?.deliveries?.[0];
  const status = !connection ? 'Status unavailable' : !connection.entitlement?.entitled
    ? 'Needs attention — subscription required' : !connection.configured ? 'Not configured'
      : latest?.status === 'FAILED' ? 'Needs attention — delivery failed'
        : latest?.status === 'RECEIVED' ? 'Delivery pending — refresh to check completion'
        : latest?.status === 'PROCESSED' ? 'Webhook delivery verified' : 'Configured — not tested';

  async function connect(e) {
    e.preventDefault(); setBusy(true); setError(''); setResult('');
    try {
      await fetchApi('/api/zapier/subscribe', { method: 'POST', body: JSON.stringify({ event, targetUrl: hook.trim() }) });
      setHook(''); await onChanged(); await refresh();
    } catch (err) { setError(err?.body?.error || 'Could not save subscription. Check the Catch Hook URL.'); }
    finally { setBusy(false); }
  }
  async function test(id) {
    if (!window.confirm('Send synthetic test data to Zapier? A published Zap may run its downstream actions.')) return;
    setBusy(true); setResult(''); setError('');
    try {
      const response = await fetchApi(`/api/zapier/subscriptions/${id}/test`, { method: 'POST' });
      setResult(`Zapier accepted the test (HTTP ${response.httpStatus}). Check Zap History to verify the final action.`);
    } catch (err) { setError(err?.body?.error || 'Test delivery failed. Check delivery history below.'); }
    finally { await refresh(); setBusy(false); }
  }
  return <section className="card" style={{ padding: 18, marginBottom: 18, display: 'grid', gap: 14 }} aria-label="Zapier guided setup">
    <h2 style={{ margin: 0, fontSize: 18 }}>Connect CRM events to Zapier</h2>
    <p role="status" style={{ margin: 0 }}>{status}</p>
    <p style={{ margin: 0, color: 'var(--text-secondary)' }}>This release uses Webhooks by Zapier, not the SDK or a verified marketplace app. Outbound Catch Hooks do not need a CRM API key.</p>
    <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7 }}>
      <li>In Zapier, create a Zap with <strong>Webhooks by Zapier → Catch Hook</strong>. Keep it listening for a test.</li>
      <li>Choose a recipe below, paste the Catch Hook URL, and save. Send a test from the saved connection.</li>
      <li>In Zapier, map the received fields to the destination action, test that action, and publish the Zap.</li>
    </ol>
    <a href="https://help.zapier.com/hc/en-us/articles/8496288690317-Trigger-Zap-workflows-from-webhooks" target="_blank" rel="noreferrer">Official Catch Hook setup guide</a>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 10 }}>
      {templates.map(item => <button key={item.event} type="button" className="btn-secondary" aria-pressed={event === item.event} onClick={() => setEvent(item.event)} style={{ textAlign: 'left', whiteSpace: 'normal', padding: 12 }}>
        <strong>{item.title}</strong><br /><small>{item.action}</small><br /><small>Map: {item.mapping}</small>
      </button>)}
    </div>
    <form onSubmit={connect} style={{ display: 'grid', gap: 8 }}>
      <label>CRM event<select className="input-field" value={event} onChange={e => setEvent(e.target.value)}>{templates.map(item => <option value={item.event} key={item.event}>{item.event}</option>)}</select></label>
      <label>Zapier Catch Hook URL<input className="input-field" type="url" required autoComplete="off" value={hook} onChange={e => setHook(e.target.value)} placeholder="https://hooks.zapier.com/hooks/catch/.../.../" style={{ width: '100%' }} /></label>
      <small>Treat this URL like a secret. Test events use synthetic data; real events may include customer information. Zapier plan requirements and charges apply separately.</small>
      <button className="btn-primary" disabled={busy}>Save connection</button>
    </form>
    {error && <p role="alert">{error}</p>}{result && <p role="status">{result}</p>}
    <h3 style={{ margin: 0 }}>Connection tests</h3>
    {subscriptions.filter(sub => String(sub.targetUrl).startsWith('https://hooks.zapier.com/')).map(sub => <div key={sub.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span>{sub.event} · connection #{sub.id}</span><button className="btn-secondary" type="button" disabled={busy} onClick={() => test(sub.id)}>Send test event #{sub.id}</button>
    </div>)}
    <div><h3 style={{ display: 'inline', marginRight: 12 }}>Recent deliveries</h3><button type="button" className="btn-secondary" onClick={refresh}>Refresh status</button></div>
    <small>Shows up to 50 of your deliveries from the latest 200 tenant records. Up to 3 immediate attempts per send; no durable background replay yet. HTTP acceptance does not verify a downstream action.</small>
    <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }} aria-label="Zapier delivery history">
      <thead><tr>{['Time', 'Connection', 'Event', 'Result', 'HTTP', 'Attempts'].map(label => <th key={label} style={{ padding: 8, textAlign: 'left' }}>{label}</th>)}</tr></thead>
      <tbody>{(connection?.deliveries || []).map(row => <tr key={row.id}><td>{new Date(row.receivedAt).toLocaleString()}</td><td>#{row.subscriptionId}</td><td>{row.event}{row.test ? ' (test)' : ''}</td><td>{row.status === 'PROCESSED' ? 'Accepted by Zapier' : row.status}{row.error ? ` — ${row.error}` : ''}</td><td>{row.httpStatus || '—'}</td><td>{row.attempts}</td></tr>)}</tbody>
    </table></div>
    {connection && !connection.deliveries?.length && <p>No recorded deliveries yet. Save a connection and send a test.</p>}
  </section>;
}
