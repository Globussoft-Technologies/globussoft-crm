// Wave 11 Agent FF — admin editor for cashback-on-completed-visit rules.
//
// Each rule earns a percentage of paid visit amount as wallet credit.
// Optional minSpend gate + service-id allowlist let admins limit cashback
// to high-tier services or premium-package visits.
import { useEffect, useState } from 'react';
import { Coins, Plus, Pencil, Trash2 } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { formatMoney } from '../../utils/money';

export default function CashbackRulesPage() {
  const [rules, setRules] = useState([]);
  const [editOpen, setEditOpen] = useState(null);
  const [loading, setLoading] = useState(true);
  const notify = useNotify();

  const load = async () => {
    setLoading(true);
    try {
      const j = await fetchApi('/api/wellness/cashback-rules');
      setRules(j.rules || []);
    } catch (e) {
      notify.error(e.message || 'Failed to load cashback rules');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const remove = async (id) => {
    if (!confirm('Delete this cashback rule? Past wallet credits remain.')) return;
    try {
      await fetchApi(`/api/wellness/cashback-rules/${id}`, { method: 'DELETE' });
      notify.success('Rule deleted');
      load();
    } catch (e) {
      notify.error(e.message || 'Failed to delete rule');
    }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Coins size={24} /> Cashback Rules
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Earn wallet credit for the patient on each completed visit. First-matching-rule wins.
          </p>
        </div>
        <button onClick={() => setEditOpen({})} style={btnPrimary}><Plus size={14} /> New rule</button>
      </header>

      {loading ? (
        <div>Loading…</div>
      ) : rules.length === 0 ? (
        <div style={{ color: 'var(--text-secondary)' }}>No cashback rules yet.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
              <th style={th}>Name</th>
              <th style={th}>Earn %</th>
              <th style={th}>Min spend</th>
              <th style={th}>Expires</th>
              <th style={th}>Status</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => {
              const expired = r.expiresAt && new Date(r.expiresAt).getTime() <= Date.now();
              const status = !r.isActive ? 'Disabled' : (expired ? 'Expired' : 'Active');
              const statusColor = !r.isActive ? 'var(--text-secondary)' : (expired ? '#c0392b' : 'var(--primary-color, var(--accent-color))');
              return (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--border-color)', opacity: expired || !r.isActive ? 0.6 : 1 }}>
                  <td style={td}>{r.name}</td>
                  <td style={td}>{r.earnPercent}%</td>
                  <td style={td}>{r.minSpend ? formatMoney(r.minSpend) : '—'}</td>
                  <td style={td}>{r.expiresAt ? new Date(r.expiresAt).toLocaleDateString() : '—'}</td>
                  <td style={{ ...td, color: statusColor, fontWeight: 500 }}>{status}</td>
                  <td style={td}>
                    <button onClick={() => setEditOpen(r)} style={iconBtn}><Pencil size={14} /></button>
                    <button onClick={() => remove(r.id)} style={iconBtn}><Trash2 size={14} /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {editOpen !== null && (
        <RuleEditor
          row={editOpen}
          onSaved={() => { setEditOpen(null); load(); }}
          onCancel={() => setEditOpen(null)}
        />
      )}
    </div>
  );
}

function RuleEditor({ row, onSaved, onCancel }) {
  const isEdit = Boolean(row && row.id);
  const [form, setForm] = useState({
    name: row.name || '',
    earnPercent: row.earnPercent ?? '',
    minSpend: row.minSpend ?? '',
    isActive: row.isActive ?? true,
    expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString().slice(0, 10) : '',
  });
  const [submitting, setSubmitting] = useState(false);
  const notify = useNotify();

  const submit = async () => {
    if (!form.name.trim()) return notify.error('Name is required.');
    const v = Number(form.earnPercent);
    if (!Number.isFinite(v) || v < 0 || v > 100) return notify.error('Earn % must be 0..100.');

    let expiresAt = null;
    if (form.expiresAt) {
      const d = new Date(form.expiresAt + 'T23:59:59');
      if (Number.isNaN(d.getTime())) return notify.error('Expiry date is invalid.');
      expiresAt = d.toISOString();
    }

    const body = {
      name: form.name.trim(),
      earnPercent: v,
      minSpend: form.minSpend !== '' && form.minSpend != null ? Number(form.minSpend) : null,
      isActive: form.isActive,
      expiresAt,
    };
    setSubmitting(true);
    try {
      if (isEdit) {
        await fetchApi(`/api/wellness/cashback-rules/${row.id}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        await fetchApi('/api/wellness/cashback-rules', { method: 'POST', body: JSON.stringify(body) });
      }
      notify.success(isEdit ? 'Rule updated' : 'Rule created');
      onSaved();
    } catch (e) {
      notify.error(e.message || 'Failed to save rule');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={modalOverlay}>
      <div style={modalCard}>
        <h3>{isEdit ? 'Edit cashback rule' : 'New cashback rule'}</h3>
        <label style={lbl}>Name
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inp} />
        </label>
        <label style={lbl}>Earn %
          <input type="number" value={form.earnPercent} onChange={(e) => setForm({ ...form, earnPercent: e.target.value })} style={inp} step="0.01" />
        </label>
        <label style={lbl}>Min spend (blank = no floor)
          <input type="number" value={form.minSpend} onChange={(e) => setForm({ ...form, minSpend: e.target.value })} style={inp} step="0.01" />
        </label>
        <label style={lbl}>Expiry date (blank = never expires)
          <input
            type="date"
            value={form.expiresAt}
            onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
            min={new Date().toISOString().slice(0, 10)}
            style={inp}
          />
          <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            After end-of-day on this date the rule stops awarding cashback (existing wallet credits are kept).
          </span>
        </label>
        <label style={{ ...lbl, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
          Active
        </label>
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
          <button onClick={onCancel} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={submit} style={btnPrimary} disabled={submitting}>{submitting ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

const th = { textAlign: 'left', padding: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' };
const td = { padding: '0.5rem', fontSize: '0.9rem' };
const btnPrimary = { padding: '0.6rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' };
const btnSecondary = { padding: '0.6rem 1rem', background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 8, cursor: 'pointer' };
const iconBtn = { background: 'transparent', border: '1px solid var(--border-color)', padding: '0.3rem 0.5rem', borderRadius: 6, cursor: 'pointer', marginRight: '0.25rem' };
const modalOverlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const modalCard = { background: 'var(--bg-color, #fff)', padding: '1.5rem', borderRadius: 12, minWidth: 360, maxWidth: 500 };
const lbl = { display: 'block', marginBottom: '0.75rem', fontSize: '0.9rem' };
const inp = { width: '100%', padding: '0.5rem 0.75rem', borderRadius: 6, border: '1px solid var(--border-color)', marginTop: '0.25rem', boxSizing: 'border-box' };
