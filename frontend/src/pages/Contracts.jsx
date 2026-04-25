import React, { useState, useEffect } from 'react';
import { FileText, Plus, Trash2, CheckCircle2, XCircle, DollarSign } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { formatMoney, currencySymbol } from '../utils/money';

const STATUS_STYLES = {
  Draft:      { bg: 'rgba(100,116,139,0.12)', color: '#94a3b8', border: 'rgba(100,116,139,0.3)' },
  Sent:       { bg: 'rgba(59,130,246,0.12)',  color: '#3b82f6', border: 'rgba(59,130,246,0.3)' },
  Active:     { bg: 'rgba(16,185,129,0.12)',  color: '#10b981', border: 'rgba(16,185,129,0.3)' },
  Expired:    { bg: 'rgba(245,158,11,0.12)',  color: '#f59e0b', border: 'rgba(245,158,11,0.3)' },
  Terminated: { bg: 'rgba(239,68,68,0.12)',   color: '#ef4444', border: 'rgba(239,68,68,0.3)' },
};

function StatusBadge({ status }) {
  const cfg = STATUS_STYLES[status] || STATUS_STYLES.Draft;
  return (
    <span style={{
      padding: '0.2rem 0.65rem', borderRadius: '999px', fontSize: '0.72rem',
      fontWeight: 'bold', backgroundColor: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.border}`,
    }}>
      {status}
    </span>
  );
}

const EMPTY_FORM = {
  title: '',
  contactId: '',
  dealId: '',
  value: '',
  startDate: '',
  endDate: '',
  terms: '',
};

export default function Contracts() {
  const notify = useNotify();
  const [contracts, setContracts] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [deals, setDeals] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    try {
      const [ct, co, dl] = await Promise.all([
        fetchApi('/api/contracts'),
        fetchApi('/api/contacts'),
        fetchApi('/api/deals'),
      ]);
      setContracts(Array.isArray(ct) ? ct : []);
      setContacts(Array.isArray(co) ? co : []);
      setDeals(Array.isArray(dl) ? dl : []);
    } catch (err) {
      console.error(err);
    }
  };

  const createContract = async (e) => {
    e.preventDefault();
    try {
      await fetchApi('/api/contracts', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setForm(EMPTY_FORM);
      loadData();
    } catch (err) {
      notify.error('Failed to create contract');
    }
  };

  const activateContract = async (id) => {
    try {
      await fetchApi(`/api/contracts/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'Active' }),
      });
      loadData();
    } catch (err) {
      console.error(err);
    }
  };

  const terminateContract = async (id) => {
    try {
      await fetchApi(`/api/contracts/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'Terminated' }),
      });
      loadData();
    } catch (err) {
      console.error(err);
    }
  };

  const deleteContract = async (id) => {
    if (!await notify.confirm({
      title: 'Delete contract',
      message: 'Are you sure you want to delete this contract? This cannot be undone.',
      confirmText: 'Delete',
      destructive: true,
    })) return;
    try {
      await fetchApi(`/api/contracts/${id}`, { method: 'DELETE' });
      loadData();
    } catch (err) {
      console.error(err);
    }
  };

  const draftCount = contracts.filter(c => c.status === 'Draft').length;
  const activeContracts = contracts.filter(c => c.status === 'Active');
  const activeCount = activeContracts.length;
  const activeValue = activeContracts.reduce((sum, c) => sum + (c.value || 0), 0);

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2.5rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <FileText size={26} color="var(--accent-color)" /> Contracts
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          Manage client contracts, track statuses, and oversee agreement lifecycle.
        </p>
      </header>

      {/* Stats bar */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.75rem', flexWrap: 'wrap' }}>
        <span style={{
          padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: '600',
          background: 'rgba(100,116,139,0.1)', color: '#94a3b8', border: '1px solid rgba(100,116,139,0.3)',
        }}>
          {draftCount} Draft
        </span>
        <span style={{
          padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: '600',
          background: 'rgba(16,185,129,0.1)', color: '#10b981', border: '1px solid rgba(16,185,129,0.3)',
        }}>
          {activeCount} Active
        </span>
        <span style={{
          padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: '600',
          background: 'var(--subtle-bg-4)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)',
          display: 'flex', alignItems: 'center', gap: '0.3rem',
        }}>
          <DollarSign size={14} /> {formatMoney(activeValue, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} active value
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '2rem' }}>

        {/* Create Form */}
        <div className="card" style={{ padding: '2rem', height: 'fit-content' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={20} color="var(--accent-color)" /> Create Contract
          </h3>
          <form onSubmit={createContract} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Contract Title</label>
              <input
                type="text" required className="input-field" placeholder="e.g. Annual SaaS License"
                value={form.title}
                onChange={e => setForm({ ...form, title: e.target.value })}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Contact</label>
              <select
                className="input-field"
                value={form.contactId}
                onChange={e => setForm({ ...form, contactId: e.target.value })}
                style={{ background: 'var(--input-bg)' }}
              >
                <option value="">-- Select Contact --</option>
                {contacts.map(c => (
                  <option key={c.id} value={c.id}>{c.name} ({c.email})</option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Deal (Optional)</label>
              <select
                className="input-field"
                value={form.dealId}
                onChange={e => setForm({ ...form, dealId: e.target.value })}
                style={{ background: 'var(--input-bg)' }}
              >
                <option value="">-- No Deal --</option>
                {deals.map(d => (
                  <option key={d.id} value={d.id}>{d.title} - {formatMoney(d.amount || 0)}</option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Value ({currencySymbol()})</label>
              <input
                type="number" step="0.01" className="input-field" placeholder="0.00"
                value={form.value}
                onChange={e => setForm({ ...form, value: e.target.value })}
              />
            </div>

            <div style={{ display: 'flex', gap: '1rem' }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Start Date</label>
                <input
                  type="date" className="input-field"
                  value={form.startDate}
                  onChange={e => setForm({ ...form, startDate: e.target.value })}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>End Date</label>
                <input
                  type="date" className="input-field"
                  value={form.endDate}
                  onChange={e => setForm({ ...form, endDate: e.target.value })}
                />
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Terms</label>
              <textarea
                className="input-field" rows="3" placeholder="Contract terms and conditions..."
                value={form.terms}
                onChange={e => setForm({ ...form, terms: e.target.value })}
              />
            </div>

            <button type="submit" className="btn-primary" style={{ padding: '1rem' }}>
              Create Contract
            </button>
          </form>
        </div>

        {/* Contracts Table */}
        <div className="card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <FileText size={20} color="var(--success-color)" /> All Contracts
          </h3>

          {contracts.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '4rem 2rem', background: 'var(--subtle-bg-2)', border: '1px dashed var(--border-color)', borderRadius: '8px' }}>
              <FileText size={48} style={{ opacity: 0.2, margin: '0 auto 1rem', color: 'var(--accent-color)' }} />
              <p style={{ color: 'var(--text-secondary)' }}>No contracts yet. Create your first contract to get started.</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Title</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Contact</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Deal</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Value</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Status</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Start</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>End</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {contracts.map(c => (
                    <tr key={c.id} style={{ borderBottom: '1px solid var(--border-color)', transition: '0.2s' }}
                      onMouseOver={e => e.currentTarget.style.background = 'var(--subtle-bg-2)'}
                      onMouseOut={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <td style={{ padding: '0.85rem 0.5rem', fontWeight: '600' }}>{c.title}</td>
                      <td style={{ padding: '0.85rem 0.5rem', color: 'var(--text-secondary)' }}>
                        {c.contact?.name || '—'}
                      </td>
                      <td style={{ padding: '0.85rem 0.5rem', color: 'var(--text-secondary)' }}>
                        {c.deal?.title || '—'}
                      </td>
                      <td style={{ padding: '0.85rem 0.5rem', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '0.15rem' }}>
                        <DollarSign size={14} color="var(--success-color)" />
                        {formatMoney(c.value || 0, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td style={{ padding: '0.85rem 0.5rem' }}>
                        <StatusBadge status={c.status} />
                      </td>
                      <td style={{ padding: '0.85rem 0.5rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                        {c.startDate ? new Date(c.startDate).toLocaleDateString() : '—'}
                      </td>
                      <td style={{ padding: '0.85rem 0.5rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                        {c.endDate ? new Date(c.endDate).toLocaleDateString() : '—'}
                      </td>
                      <td style={{ padding: '0.85rem 0.5rem' }}>
                        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                          {c.status !== 'Active' && c.status !== 'Terminated' && (
                            <button
                              onClick={() => activateContract(c.id)}
                              className="btn-secondary"
                              style={{
                                padding: '0.35rem 0.65rem', fontSize: '0.75rem',
                                background: 'var(--success-color)', color: '#fff', border: 'none',
                                display: 'flex', alignItems: 'center', gap: '0.25rem',
                              }}
                            >
                              <CheckCircle2 size={12} /> Activate
                            </button>
                          )}
                          {c.status !== 'Terminated' && (
                            <button
                              onClick={() => terminateContract(c.id)}
                              className="btn-secondary"
                              style={{
                                padding: '0.35rem 0.65rem', fontSize: '0.75rem',
                                background: 'transparent', color: '#f59e0b',
                                border: '1px solid rgba(245,158,11,0.3)',
                                display: 'flex', alignItems: 'center', gap: '0.25rem',
                              }}
                            >
                              <XCircle size={12} /> Terminate
                            </button>
                          )}
                          <button
                            onClick={() => deleteContract(c.id)}
                            style={{
                              background: 'transparent', border: '1px solid rgba(239,68,68,0.3)',
                              color: 'var(--text-secondary)', cursor: 'pointer',
                              display: 'flex', alignItems: 'center', gap: '0.25rem',
                              fontSize: '0.75rem', padding: '0.35rem 0.65rem', borderRadius: '6px',
                            }}
                            onMouseOver={e => e.currentTarget.style.color = '#ef4444'}
                            onMouseOut={e => e.currentTarget.style.color = 'var(--text-secondary)'}
                          >
                            <Trash2 size={12} /> Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}
