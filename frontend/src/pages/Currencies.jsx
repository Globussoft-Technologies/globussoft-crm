import React, { useState, useEffect } from 'react';
import { DollarSign, Plus, Edit, Star, Trash2, RefreshCw, X, TrendingUp } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { formatCurrency } from '../utils/currency';

export default function Currencies() {
  const notify = useNotify();
  const [currencies, setCurrencies] = useState([]);
  const [pivot, setPivot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editRate, setEditRate] = useState('');
  const [form, setForm] = useState({ code: '', symbol: '', name: '', exchangeRate: 1.0, isBase: false });
  const [error, setError] = useState('');

  const isPersisted = currencies.length > 0 && currencies[0].id > 0;

  const load = async () => {
    setLoading(true);
    try {
      const [c, p] = await Promise.all([
        fetchApi('/api/currencies'),
        fetchApi('/api/currencies/pivot/deals').catch(() => null),
      ]);
      setCurrencies(c || []);
      setPivot(p);
    } catch (e) {
      setError(e.message || 'Failed to load currencies');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleSeed = async () => {
    try {
      await fetchApi('/api/currencies/seed', { method: 'POST' });
      load();
    } catch (e) { notify.error(e.message || 'Failed to initialize defaults'); }
  };

  const handleAdd = async () => {
    if (!form.code || !form.symbol || !form.name) return notify.error('Code, symbol, and name are required');
    try {
      await fetchApi('/api/currencies', {
        method: 'POST',
        body: JSON.stringify({ ...form, exchangeRate: parseFloat(form.exchangeRate) || 1 }),
      });
      setShowAdd(false);
      setForm({ code: '', symbol: '', name: '', exchangeRate: 1.0, isBase: false });
      load();
    } catch (e) { notify.error(e.message || 'Failed to create currency'); }
  };

  const handleSetBase = async (id) => {
    try {
      await fetchApi(`/api/currencies/${id}/set-base`, { method: 'POST' });
      load();
    } catch (e) { notify.error(e.message || 'Failed to set base'); }
  };

  const handleDelete = async (id) => {
    if (!await notify.confirm('Delete this currency?')) return;
    try {
      await fetchApi(`/api/currencies/${id}`, { method: 'DELETE' });
      load();
    } catch (e) { notify.error(e.message || 'Failed to delete'); }
  };

  const startEdit = (c) => { setEditingId(c.id); setEditRate(String(c.exchangeRate)); };
  const saveEdit = async (id) => {
    try {
      await fetchApi(`/api/currencies/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ exchangeRate: parseFloat(editRate) || 1 }),
      });
      setEditingId(null);
      load();
    } catch (e) { notify.error(e.message || 'Failed to update rate'); }
  };

  const baseCurrency = currencies.find((c) => c.isBase) || currencies[0];

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      <header style={{ marginBottom: '2rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <DollarSign size={24} style={{ color: 'var(--accent-color)' }} />
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Currencies</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Manage currencies, FX rates, and per-deal currency conversion</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn-secondary" onClick={load} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1rem', fontSize: '0.85rem' }}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button className="btn-primary" onClick={() => setShowAdd(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1rem', fontSize: '0.85rem' }}>
            <Plus size={15} /> Add Currency
          </button>
        </div>
      </header>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
        <StatCard
          icon={<DollarSign size={18} />}
          label="Active Currencies"
          value={currencies.length}
          accent="#10b981"
        />
        <StatCard
          icon={<Star size={18} />}
          label="Base Currency"
          value={baseCurrency ? `${baseCurrency.code} (${baseCurrency.symbol})` : '—'}
          accent="#f59e0b"
        />
        <StatCard
          icon={<TrendingUp size={18} />}
          label={`Open Pipeline (in ${pivot?.baseCode || baseCurrency?.code || 'base'})`}
          value={pivot ? formatCurrency(pivot.totalInBase, pivot.baseCode) : '—'}
          subtitle={pivot ? `${pivot.dealCount} open deals` : ''}
          accent="#6366f1"
        />
      </div>

      {!isPersisted && (
        <div className="card" style={{ padding: '1.25rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderLeft: '3px solid #f59e0b' }}>
          <div>
            <div style={{ fontWeight: 600 }}>Default currencies (preview)</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>You have not initialized currencies for your tenant yet. Click below to persist USD, INR, EUR, GBP, CAD, AUD with USD as base.</div>
          </div>
          <button className="btn-primary" onClick={handleSeed} style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}>Initialize Defaults</button>
        </div>
      )}

      {error && (
        <div className="card" style={{ padding: '1rem', marginBottom: '1rem', color: '#ef4444', borderLeft: '3px solid #ef4444' }}>{error}</div>
      )}

      {/* Pivot card */}
      {pivot && (
        <div className="card" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
          <h3 style={{ fontWeight: 600, marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <TrendingUp size={16} /> Open Pipeline by Currency
          </h3>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            {Object.keys(pivot.byCurrency || {}).length === 0 && (
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>No open deals yet.</p>
            )}
            {Object.entries(pivot.byCurrency || {}).map(([code, info]) => (
              <div key={code} style={{ padding: '0.75rem 1rem', background: 'var(--subtle-bg)', borderRadius: '8px', minWidth: 160 }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{code} · {info.count} deals</div>
                <div style={{ fontWeight: 600, fontSize: '1rem' }}>{formatCurrency(info.amount, code)}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Total in {pivot.baseCode}</span>
            <span style={{ fontWeight: 700, fontSize: '1.125rem', color: 'var(--accent-color)' }}>{formatCurrency(pivot.totalInBase, pivot.baseCode)}</span>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading currencies...</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--subtle-bg)', textAlign: 'left' }}>
                <th style={th}>Code</th>
                <th style={th}>Symbol</th>
                <th style={th}>Name</th>
                <th style={th}>Exchange Rate</th>
                <th style={{ ...th, textAlign: 'center' }}>Base</th>
                <th style={{ ...th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {currencies.map((c) => {
                const persisted = c.id > 0;
                return (
                  <tr key={c.id} style={{ borderTop: '1px solid var(--border-color)' }}>
                    <td style={td}><strong>{c.code}</strong></td>
                    <td style={td}><span style={{ fontSize: '1.05rem' }}>{c.symbol}</span></td>
                    <td style={td}>{c.name}</td>
                    <td style={td}>
                      {editingId === c.id ? (
                        <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
                          <input
                            className="input-field"
                            type="number"
                            step="0.0001"
                            value={editRate}
                            onChange={(e) => setEditRate(e.target.value)}
                            style={{ width: 110, padding: '0.25rem 0.5rem', fontSize: '0.85rem' }}
                          />
                          <button className="btn-primary" onClick={() => saveEdit(c.id)} style={{ padding: '0.25rem 0.625rem', fontSize: '0.75rem' }}>Save</button>
                          <button onClick={() => setEditingId(null)} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>Cancel</button>
                        </div>
                      ) : (
                        <span style={{ fontFamily: 'monospace' }}>{Number(c.exchangeRate).toFixed(4)}</span>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: 'center' }}>
                      <input
                        type="radio"
                        name="baseCurrency"
                        checked={!!c.isBase}
                        disabled={!persisted}
                        onChange={() => persisted && handleSetBase(c.id)}
                        title={persisted ? 'Set as base' : 'Initialize defaults first'}
                        style={{ cursor: persisted ? 'pointer' : 'not-allowed' }}
                      />
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: '0.25rem' }}>
                        {persisted && !c.isBase && (
                          <button onClick={() => handleSetBase(c.id)} title="Set as base" style={iconBtn}>
                            <Star size={14} />
                          </button>
                        )}
                        {persisted && (
                          <button onClick={() => startEdit(c)} title="Edit rate" style={iconBtn}>
                            <Edit size={14} />
                          </button>
                        )}
                        {persisted && !c.isBase && (
                          <button onClick={() => handleDelete(c.id)} title="Delete" style={{ ...iconBtn, color: '#ef4444' }}>
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {currencies.length === 0 && (
                <tr><td colSpan={6} style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No currencies configured.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Add Modal */}
      {showAdd && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay-bg, rgba(0,0,0,0.6))', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
          <div className="card" style={{ padding: '2rem', width: 460 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <h3 style={{ fontWeight: 'bold' }}>Add Currency</h3>
              <button onClick={() => setShowAdd(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}><X size={18} /></button>
            </div>
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              <input className="input-field" placeholder="Code (e.g. JPY)" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
              <input className="input-field" placeholder="Symbol (e.g. ¥)" value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} />
              <input className="input-field" placeholder="Name (e.g. Japanese Yen)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <input className="input-field" type="number" step="0.0001" placeholder="Exchange rate (1 base = X)" value={form.exchangeRate} onChange={(e) => setForm({ ...form, exchangeRate: e.target.value })} />
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', cursor: 'pointer' }}>
                <input type="checkbox" checked={form.isBase} onChange={(e) => setForm({ ...form, isBase: e.target.checked })} />
                Set as base currency
              </label>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1.5rem' }}>
              <button onClick={() => setShowAdd(false)} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>Cancel</button>
              <button className="btn-primary" onClick={handleAdd}>Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const th = { padding: '0.75rem 1rem', fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)', fontWeight: 600 };
const td = { padding: '0.75rem 1rem', fontSize: '0.9rem' };
const iconBtn = { background: 'var(--subtle-bg)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '0.375rem 0.5rem', cursor: 'pointer', color: 'var(--text-secondary)' };

function StatCard({ icon, label, value, subtitle, accent }) {
  return (
    <div className="card" style={{ padding: '1rem 1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: accent, marginBottom: '0.375rem' }}>
        {icon}
        <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)' }}>{label}</span>
      </div>
      <div style={{ fontSize: '1.35rem', fontWeight: 700 }}>{value}</div>
      {subtitle && <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>{subtitle}</div>}
    </div>
  );
}
