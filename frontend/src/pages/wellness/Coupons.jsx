// Wave 11 Agent FF — admin CRUD for promotion / discount coupons.
//
// Two flows:
//   • CRUD list — manage active + inactive coupons.
//   • Preview — paste a code + base amount, see the discount math (does NOT
//     redeem; safe for demo). Mirrors how the checkout would call the same
//     endpoint pre-/api/wellness/coupons/apply.
import { useEffect, useState } from 'react';
import { TicketPercent, Plus, Pencil, Trash2 } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { formatMoney } from '../../utils/money';

export default function CouponsPage() {
  const [coupons, setCoupons] = useState([]);
  const [editOpen, setEditOpen] = useState(null); // null | {} (new) | row
  const [previewOpen, setPreviewOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const notify = useNotify();

  const load = async () => {
    setLoading(true);
    try {
      const j = await fetchApi('/api/wellness/coupons');
      setCoupons(j.coupons || []);
    } catch (e) {
      notify.error(e.message || 'Failed to load coupons');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const remove = async (id) => {
    const ok = await notify.confirm({
      title: 'Delete coupon',
      message: 'Delete this coupon? This cannot be undone.',
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/wellness/coupons/${id}`, { method: 'DELETE' });
      notify.success('Coupon deleted');
      load();
    } catch (e) {
      notify.error(e.message || 'Failed to delete coupon');
    }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <TicketPercent size={24} /> Coupons
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Promotional discounts (PERCENT or FLAT). Apply at checkout to credit the bill.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={() => setPreviewOpen(true)} style={btnSecondary}>Preview a code</button>
          <button onClick={() => setEditOpen({})} style={btnPrimary}><Plus size={14} /> New coupon</button>
        </div>
      </header>

      {loading ? (
        <div>Loading…</div>
      ) : coupons.length === 0 ? (
        <div style={{ color: 'var(--text-secondary)' }}>No coupons yet.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
              <th style={th}>Code</th>
              <th style={th}>Discount</th>
              <th style={th}>Redemptions</th>
              <th style={th}>Validity</th>
              <th style={th}>Active</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {coupons.map((c) => (
              <tr key={c.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                <td style={td}><code>{c.code}</code></td>
                <td style={td}>{c.discountType === 'PERCENT' ? `${c.discountValue}%` : formatMoney(c.discountValue)}</td>
                <td style={td}>{c.redemptionCount}{c.maxRedemptions ? ` / ${c.maxRedemptions}` : ''}</td>
                <td style={td}>{validityLabel(c)}</td>
                <td style={td}>{c.isActive ? 'Yes' : 'No'}</td>
                <td style={td}>
                  <button onClick={() => setEditOpen(c)} style={iconBtn}><Pencil size={14} /></button>
                  <button onClick={() => remove(c.id)} style={iconBtn}><Trash2 size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editOpen !== null && (
        <CouponEditor
          row={editOpen}
          onSaved={() => { setEditOpen(null); load(); }}
          onCancel={() => setEditOpen(null)}
        />
      )}
      {previewOpen && <PreviewModal onClose={() => setPreviewOpen(false)} />}
    </div>
  );
}

function validityLabel(c) {
  if (c.validFrom && c.validUntil) return `${shortDate(c.validFrom)} → ${shortDate(c.validUntil)}`;
  if (c.validUntil) return `until ${shortDate(c.validUntil)}`;
  if (c.validFrom) return `from ${shortDate(c.validFrom)}`;
  return '—';
}

function shortDate(d) {
  if (!d) return '—';
  return new Date(d).toISOString().slice(0, 10);
}

function CouponEditor({ row, onSaved, onCancel }) {
  const isEdit = Boolean(row && row.id);
  const [form, setForm] = useState({
    code: row.code || '',
    discountType: row.discountType || 'PERCENT',
    discountValue: row.discountValue ?? '',
    maxRedemptions: row.maxRedemptions ?? '',
    validFrom: row.validFrom ? shortDate(row.validFrom) : '',
    validUntil: row.validUntil ? shortDate(row.validUntil) : '',
    isActive: row.isActive ?? true,
  });
  const [submitting, setSubmitting] = useState(false);
  const notify = useNotify();

  const submit = async () => {
    if (!form.code.trim()) return notify.error('Code is required.');
    const v = Number(form.discountValue);
    if (!Number.isFinite(v) || v <= 0) return notify.error('Discount value must be positive.');
    if (form.discountType === 'PERCENT' && v > 100) return notify.error('PERCENT must be ≤ 100.');

    const body = {
      code: form.code.trim().toUpperCase(),
      discountType: form.discountType,
      discountValue: v,
      maxRedemptions: form.maxRedemptions ? parseInt(form.maxRedemptions, 10) : null,
      validFrom: form.validFrom || null,
      validUntil: form.validUntil || null,
      isActive: form.isActive,
    };
    setSubmitting(true);
    try {
      if (isEdit) {
        await fetchApi(`/api/wellness/coupons/${row.id}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        await fetchApi('/api/wellness/coupons', { method: 'POST', body: JSON.stringify(body) });
      }
      notify.success(isEdit ? 'Coupon updated' : 'Coupon created');
      onSaved();
    } catch (e) {
      notify.error(e.message || 'Failed to save coupon');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={modalOverlay}>
      <div style={modalCard}>
        <h3>{isEdit ? 'Edit coupon' : 'New coupon'}</h3>
        <label style={lbl}>Code
          <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} style={inp} disabled={isEdit} />
        </label>
        <label style={lbl}>Type
          <select value={form.discountType} onChange={(e) => setForm({ ...form, discountType: e.target.value })} style={inp}>
            <option value="PERCENT">Percent (%)</option>
            <option value="FLAT">Flat amount</option>
          </select>
        </label>
        <label style={lbl}>Discount value
          <input type="number" value={form.discountValue} onChange={(e) => setForm({ ...form, discountValue: e.target.value })} style={inp} step="0.01" />
        </label>
        <label style={lbl}>Max redemptions (blank = unlimited)
          <input type="number" value={form.maxRedemptions} onChange={(e) => setForm({ ...form, maxRedemptions: e.target.value })} style={inp} />
        </label>
        <label style={lbl}>Valid from
          <input type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} style={inp} />
        </label>
        <label style={lbl}>Valid until
          <input type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} style={inp} />
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

function PreviewModal({ onClose }) {
  const [code, setCode] = useState('');
  const [baseAmount, setBaseAmount] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const preview = async () => {
    setError(null);
    setResult(null);
    setSubmitting(true);
    try {
      const j = await fetchApi('/api/wellness/coupons/preview', {
        method: 'POST',
        body: JSON.stringify({ code: code.trim().toUpperCase(), baseAmount: Number(baseAmount) }),
      });
      setResult(j);
    } catch (e) {
      setError(e.message || 'Preview failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={modalOverlay}>
      <div style={modalCard}>
        <h3>Preview a coupon</h3>
        <label style={lbl}>Code
          <input value={code} onChange={(e) => setCode(e.target.value)} style={inp} />
        </label>
        <label style={lbl}>Base amount
          <input type="number" value={baseAmount} onChange={(e) => setBaseAmount(e.target.value)} style={inp} step="0.01" />
        </label>
        <button onClick={preview} style={btnPrimary} disabled={submitting}>
          {submitting ? 'Computing…' : 'Preview'}
        </button>
        {error && <div style={{ color: 'var(--danger-color, #ef4444)', marginTop: '1rem' }}>{error}</div>}
        {result && (
          <div className="glass" style={{ marginTop: '1rem', padding: '1rem' }}>
            <div>Code: <strong>{result.code}</strong></div>
            <div>Discount: <strong>{formatMoney(result.discount)}</strong></div>
            <div>You pay: <strong>{formatMoney(result.finalAmount)}</strong></div>
            {!result.applied && <div style={{ color: 'var(--warning-color, #f59e0b)' }}>Coupon does not apply to this purchase.</div>}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}>
          <button onClick={onClose} style={btnSecondary}>Close</button>
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
