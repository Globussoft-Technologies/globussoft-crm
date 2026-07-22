import { Plus, X, Package } from 'lucide-react';
import { inputStyle } from './utils';
import TopScrollSync from '../../../components/TopScrollSync';

export function EntitlementEditor({ entitlements, services, onAdd, onRemove, onUpdate }) {
  return (
    <div style={{ marginTop: '1.25rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <strong style={{ fontSize: '0.9rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
          <Package size={14} /> Service entitlements
        </strong>
        <button type="button" onClick={onAdd} style={{ padding: '0.3rem 0.7rem', fontSize: '0.8rem', background: 'transparent', border: '1px solid var(--accent-color)', color: 'var(--accent-color)', borderRadius: 6, cursor: 'pointer' }}>
          <Plus size={12} style={{ verticalAlign: 'middle' }} /> Add row
        </button>
      </div>
      {entitlements.length === 0 ? (
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>Add at least one service + quantity (e.g. Facial × 10).</p>
      ) : (
        <TopScrollSync>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
              <th style={{ textAlign: 'left', padding: '0.35rem 0' }}>Service</th>
              <th style={{ textAlign: 'left', padding: '0.35rem 0', width: 110 }}>Quantity</th>
              <th style={{ width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {entitlements.map((row, idx) => (
              <tr key={idx} style={{ borderBottom: '1px solid var(--border-color)' }}>
                <td style={{ padding: '0.35rem 0' }}>
                  <select value={row.serviceId} onChange={(e) => onUpdate(idx, 'serviceId', e.target.value)} style={{ ...inputStyle, padding: '0.4rem' }}>
                    {services.filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </td>
                <td style={{ padding: '0.35rem 0' }}>
                  <input type="number" min={1} value={row.quantity} onChange={(e) => onUpdate(idx, 'quantity', e.target.value)} style={{ ...inputStyle, padding: '0.4rem', width: 90 }} />
                </td>
                <td>
                  <button type="button" onClick={() => onRemove(idx)} style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer' }}>
                    <X size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </TopScrollSync>
      )}
    </div>
  );
}
