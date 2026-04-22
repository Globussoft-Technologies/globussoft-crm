import React, { useState, useEffect } from 'react';
import { fetchApi } from '../utils/api';
import { formatMoney, currencySymbol } from '../utils/money';
import { Receipt, Plus, Trash2, CheckCircle2, XCircle, DollarSign } from 'lucide-react';

const CATEGORY_OPTIONS = ['General', 'Travel', 'Software', 'Office', 'Marketing', 'Other'];

const STATUS_CONFIG = {
  Pending:    { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.3)' },
  Approved:   { color: '#10b981', bg: 'rgba(16,185,129,0.1)', border: 'rgba(16,185,129,0.3)' },
  Rejected:   { color: '#ef4444', bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.3)' },
  Reimbursed: { color: '#3b82f6', bg: 'rgba(59,130,246,0.1)', border: 'rgba(59,130,246,0.3)' },
};

const CATEGORY_COLORS = {
  General:   { color: '#64748b', bg: 'rgba(100,116,139,0.1)' },
  Travel:    { color: '#8b5cf6', bg: 'rgba(139,92,246,0.1)' },
  Software:  { color: '#3b82f6', bg: 'rgba(59,130,246,0.1)' },
  Office:    { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  Marketing: { color: '#ec4899', bg: 'rgba(236,72,153,0.1)' },
  Other:     { color: '#6b7280', bg: 'rgba(107,114,128,0.1)' },
};

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.Pending;
  return (
    <span style={{
      padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.7rem',
      fontWeight: 'bold', backgroundColor: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.border}`,
    }}>
      {status}
    </span>
  );
}

function CategoryBadge({ category }) {
  const cfg = CATEGORY_COLORS[category] || CATEGORY_COLORS.General;
  return (
    <span style={{
      padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.7rem',
      fontWeight: '600', backgroundColor: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.color}33`,
    }}>
      {category}
    </span>
  );
}

export default function Expenses() {
  const [expenses, setExpenses] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [form, setForm] = useState({
    title: '', amount: '', category: 'General', expenseDate: '', notes: '', contactId: '',
  });

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    try {
      const [e, c] = await Promise.all([
        fetchApi('/api/expenses'),
        fetchApi('/api/contacts'),
      ]);
      setExpenses(Array.isArray(e) ? e : []);
      setContacts(Array.isArray(c) ? c : []);
    } catch (err) {
      console.error(err);
    }
  };

  const createExpense = async (e) => {
    e.preventDefault();
    try {
      await fetchApi('/api/expenses', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          amount: parseFloat(form.amount),
          contactId: form.contactId || null,
        }),
      });
      setForm({ title: '', amount: '', category: 'General', expenseDate: '', notes: '', contactId: '' });
      loadData();
    } catch (err) {
      alert('Failed to create expense');
    }
  };

  const updateStatus = async (id, status) => {
    try {
      await fetchApi(`/api/expenses/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
      });
      loadData();
    } catch (err) {
      console.error(err);
    }
  };

  const deleteExpense = async (id) => {
    if (!window.confirm('Delete this expense? This action cannot be undone.')) return;
    try {
      await fetchApi(`/api/expenses/${id}`, { method: 'DELETE' });
      loadData();
    } catch (err) {
      console.error(err);
    }
  };

  const totalPending = expenses
    .filter(e => e.status === 'Pending')
    .reduce((sum, e) => sum + e.amount, 0);
  const totalApproved = expenses
    .filter(e => e.status === 'Approved')
    .reduce((sum, e) => sum + e.amount, 0);
  const totalReimbursed = expenses
    .filter(e => e.status === 'Reimbursed')
    .reduce((sum, e) => sum + e.amount, 0);

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Receipt size={26} color="var(--accent-color)" /> Expense Management
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          Track, approve, and reimburse team expenses.
        </p>
      </header>

      {/* Summary Stats */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.75rem', flexWrap: 'wrap' }}>
        <span style={{
          padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: '600',
          background: 'rgba(245,158,11,0.1)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.3)',
          display: 'flex', alignItems: 'center', gap: '0.4rem',
        }}>
          <DollarSign size={12} /> Pending: ${totalPending.toFixed(2)}
        </span>
        <span style={{
          padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: '600',
          background: 'rgba(16,185,129,0.1)', color: '#10b981', border: '1px solid rgba(16,185,129,0.3)',
          display: 'flex', alignItems: 'center', gap: '0.4rem',
        }}>
          <CheckCircle2 size={12} /> Approved: ${totalApproved.toFixed(2)}
        </span>
        <span style={{
          padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: '600',
          background: 'rgba(59,130,246,0.1)', color: '#3b82f6', border: '1px solid rgba(59,130,246,0.3)',
          display: 'flex', alignItems: 'center', gap: '0.4rem',
        }}>
          <DollarSign size={12} /> Reimbursed: ${totalReimbursed.toFixed(2)}
        </span>
        <span style={{
          padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: '600',
          background: 'var(--subtle-bg-4)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)',
        }}>
          {expenses.length} total expenses
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '2rem' }}>

        {/* Create Expense Form */}
        <div className="card" style={{ padding: '2rem', height: 'fit-content' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={20} color="var(--accent-color)" /> New Expense
          </h3>
          <form onSubmit={createExpense} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Title</label>
              <input type="text" required className="input-field" placeholder="e.g. Client Dinner"
                value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Amount ({currencySymbol()})</label>
              <input type="number" step="0.01" min="0" required className="input-field" placeholder="0.00"
                value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Category</label>
              <select className="input-field" value={form.category}
                onChange={e => setForm({ ...form, category: e.target.value })}
                style={{ background: 'var(--input-bg)' }}>
                {CATEGORY_OPTIONS.map(cat => <option key={cat} value={cat}>{cat}</option>)}
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Date</label>
              <input type="date" className="input-field" value={form.expenseDate}
                onChange={e => setForm({ ...form, expenseDate: e.target.value })} />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Associated Contact</label>
              <select className="input-field" value={form.contactId}
                onChange={e => setForm({ ...form, contactId: e.target.value })}
                style={{ background: 'var(--input-bg)' }}>
                <option value="">-- None --</option>
                {contacts.map(c => <option key={c.id} value={c.id}>{c.name} ({c.email})</option>)}
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Notes</label>
              <textarea className="input-field" rows="3" placeholder="Additional details..."
                value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
            </div>

            <button type="submit" className="btn-primary" style={{ padding: '1rem' }}>
              Submit Expense
            </button>
          </form>
        </div>

        {/* Expenses Table */}
        <div className="card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Receipt size={20} color="var(--accent-color)" /> All Expenses
          </h3>

          {expenses.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>
              No expenses recorded yet.
            </p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Title</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Amount</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Category</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Status</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>User</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Date</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {expenses.map(exp => (
                    <tr key={exp.id} style={{ borderBottom: '1px solid var(--border-color)', transition: '0.15s' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--subtle-bg-2)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                      <td style={{ padding: '0.75rem 0.5rem', fontWeight: '500' }}>{exp.title}</td>
                      <td style={{ padding: '0.75rem 0.5rem', fontWeight: '600', color: '#10b981' }}>
                        ${parseFloat(exp.amount).toFixed(2)}
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem' }}>
                        <CategoryBadge category={exp.category} />
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem' }}>
                        <StatusBadge status={exp.status} />
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)' }}>
                        {exp.user ? exp.user.name || exp.user.email : '—'}
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)' }}>
                        {new Date(exp.expenseDate).toLocaleDateString()}
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem' }}>
                        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                          {exp.status === 'Pending' && (
                            <>
                              <button
                                onClick={() => updateStatus(exp.id, 'Approved')}
                                title="Approve"
                                style={{
                                  display: 'flex', alignItems: 'center', gap: '0.25rem',
                                  background: 'rgba(16,185,129,0.15)', color: '#10b981',
                                  border: '1px solid rgba(16,185,129,0.3)', borderRadius: '6px',
                                  padding: '0.3rem 0.6rem', fontSize: '0.7rem', fontWeight: '600',
                                  cursor: 'pointer', transition: '0.15s',
                                }}>
                                <CheckCircle2 size={12} /> Approve
                              </button>
                              <button
                                onClick={() => updateStatus(exp.id, 'Rejected')}
                                title="Reject"
                                style={{
                                  display: 'flex', alignItems: 'center', gap: '0.25rem',
                                  background: 'rgba(239,68,68,0.15)', color: '#ef4444',
                                  border: '1px solid rgba(239,68,68,0.3)', borderRadius: '6px',
                                  padding: '0.3rem 0.6rem', fontSize: '0.7rem', fontWeight: '600',
                                  cursor: 'pointer', transition: '0.15s',
                                }}>
                                <XCircle size={12} /> Reject
                              </button>
                            </>
                          )}
                          {exp.status === 'Approved' && (
                            <button
                              onClick={() => updateStatus(exp.id, 'Reimbursed')}
                              title="Mark Reimbursed"
                              style={{
                                display: 'flex', alignItems: 'center', gap: '0.25rem',
                                background: 'rgba(59,130,246,0.15)', color: '#3b82f6',
                                border: '1px solid rgba(59,130,246,0.3)', borderRadius: '6px',
                                padding: '0.3rem 0.6rem', fontSize: '0.7rem', fontWeight: '600',
                                cursor: 'pointer', transition: '0.15s',
                              }}>
                              <DollarSign size={12} /> Reimburse
                            </button>
                          )}
                          <button
                            onClick={() => deleteExpense(exp.id)}
                            title="Delete"
                            style={{
                              display: 'flex', alignItems: 'center', gap: '0.25rem',
                              background: 'rgba(239,68,68,0.08)', color: '#ef4444',
                              border: '1px solid rgba(239,68,68,0.2)', borderRadius: '6px',
                              padding: '0.3rem 0.6rem', fontSize: '0.7rem', fontWeight: '600',
                              cursor: 'pointer', transition: '0.15s',
                            }}>
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
