import React, { useState, useEffect } from 'react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { formatMoney, currencySymbol } from '../utils/money';
import { formatDate } from '../utils/date';
import { Receipt, Plus, Trash2, CheckCircle2, XCircle, DollarSign } from 'lucide-react';
import { DateRangeFilter, resolveDateRange, EMPTY_DATE_FILTER } from '../components/wellness/DateRangeFilter';

const CATEGORY_OPTIONS = [
  'Building Rent',
  'Business Loan Repayment',
  'Electricity Bill',
  'Employee Commission',
  'Employee Salary',
  'Equipment Purchase',
  'Insurance Expenses',
  'Internet Bill',
  'Janitorial Expenses',
  'Marketing Expenses',
  'Miscellaneous',
  'Pantry',
  'Phone Bill',
  'Product Purchase',
  'Repair & Maintenance',
  'Software/Tech Expenses',
  'Staff Rent Expenses',
  'Stationery',
  'Supplier Payment',
  'Tips for Staff',
  'Travel',
];

const PAYMENT_METHODS = ['cash', 'card', 'online', 'upi'];

const STATUS_CONFIG = {
  Draft:      { color: '#6b7280', bg: 'rgba(107,114,128,0.1)', border: 'rgba(107,114,128,0.3)' },
  Pending:    { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.3)' },
  Approved:   { color: '#10b981', bg: 'rgba(16,185,129,0.1)', border: 'rgba(16,185,129,0.3)' },
  Rejected:   { color: '#ef4444', bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.3)' },
  Reimbursed: { color: '#3b82f6', bg: 'rgba(59,130,246,0.1)', border: 'rgba(59,130,246,0.3)' },
};

// Generic category palette — categories that aren't explicitly listed fall back
// to a stable hash-based hue so any new category renders consistently.
const CATEGORY_COLORS = {
  Travel:                  { color: '#8b5cf6', bg: 'rgba(139,92,246,0.1)' },
  'Software/Tech Expenses':{ color: '#3b82f6', bg: 'rgba(59,130,246,0.1)' },
  'Marketing Expenses':    { color: '#ec4899', bg: 'rgba(236,72,153,0.1)' },
  'Product Purchase':      { color: '#10b981', bg: 'rgba(16,185,129,0.1)' },
  'Employee Salary':       { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  'Employee Commission':   { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  Pantry:                  { color: '#84cc16', bg: 'rgba(132,204,22,0.1)' },
  'Electricity Bill':      { color: '#eab308', bg: 'rgba(234,179,8,0.1)' },
  'Internet Bill':         { color: '#06b6d4', bg: 'rgba(6,182,212,0.1)' },
  'Phone Bill':            { color: '#06b6d4', bg: 'rgba(6,182,212,0.1)' },
  'Building Rent':         { color: '#a855f7', bg: 'rgba(168,85,247,0.1)' },
  'Staff Rent Expenses':   { color: '#a855f7', bg: 'rgba(168,85,247,0.1)' },
  Miscellaneous:           { color: '#6b7280', bg: 'rgba(107,114,128,0.1)' },
};
function categoryStyle(category) {
  if (CATEGORY_COLORS[category]) return CATEGORY_COLORS[category];
  // Hash-based fallback — same category → same color across reloads.
  let h = 0;
  for (let i = 0; i < (category || '').length; i++) h = (h * 31 + category.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return { color: `hsl(${hue}, 55%, 50%)`, bg: `hsla(${hue}, 55%, 50%, 0.12)` };
}

// Payment methods are persisted as a JSON object in Expense.notes (no schema
// migration). Encoder + decoder live here so the read path (table) and the
// write path (create) stay in sync.
function encodePayment(payment) {
  const filtered = {};
  for (const k of PAYMENT_METHODS) {
    const n = parseFloat(payment[k]);
    if (Number.isFinite(n) && n > 0) filtered[k] = n;
  }
  if (Object.keys(filtered).length === 0) return null;
  return JSON.stringify({ payment: filtered });
}

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
  const cfg = categoryStyle(category);
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

const EMPTY_FORM = {
  recipientName: '',
  description: '',
  category: CATEGORY_OPTIONS[0],
  amount: '',
  expenseDate: '',
  payment: { cash: '', card: '', online: '', upi: '' },
};

export default function Expenses() {
  const notify = useNotify();
  const [expenses, setExpenses] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [dateFilter, setDateFilter] = useState(EMPTY_DATE_FILTER);
  const [rangeStart, rangeEnd] = resolveDateRange(dateFilter);
  // Filter by expenseDate when set, fall back to createdAt for legacy rows
  // that haven't backfilled expenseDate.
  const visibleExpenses = (rangeStart && rangeEnd)
    ? expenses.filter((exp) => {
        const d = exp.expenseDate || exp.createdAt;
        if (!d) return false;
        const ts = new Date(d).getTime();
        return ts >= rangeStart.getTime() && ts <= rangeEnd.getTime();
      })
    : expenses;

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    try {
      const e = await fetchApi('/api/expenses');
      setExpenses(Array.isArray(e) ? e : []);
    } catch (err) {
      console.error(err);
    }
  };

  const createExpense = async (e, status = 'Pending') => {
    e.preventDefault();
    if (!form.recipientName.trim()) return notify.error('Recipient name is required');
    if (!form.amount || parseFloat(form.amount) <= 0) return notify.error('Amount is required');
    if (!form.expenseDate) return notify.error('Transaction date is required');

    // Validate that payment-method total roughly matches Amount when any
    // breakdown is entered. Mismatch within ±0.01 is treated as fine.
    const paymentTotal = PAYMENT_METHODS.reduce((s, k) => s + (parseFloat(form.payment[k]) || 0), 0);
    if (paymentTotal > 0 && Math.abs(paymentTotal - parseFloat(form.amount)) > 0.01) {
      return notify.error(`Payment-method total (${paymentTotal.toFixed(2)}) doesn't match Amount (${parseFloat(form.amount).toFixed(2)}).`);
    }

    try {
      await fetchApi('/api/expenses', {
        method: 'POST',
        body: JSON.stringify({
          title: form.recipientName.trim(),
          description: form.description.trim() || null,
          amount: parseFloat(form.amount),
          category: form.category,
          expenseDate: form.expenseDate,
          notes: encodePayment(form.payment),
          status,
        }),
      });
      setForm(EMPTY_FORM);
      notify.success(`Expense created as ${status}`);
      loadData();
    } catch (err) {
      notify.error('Failed to create expense');
    }
  };

  const submitExpense = async (id) => {
    try {
      await fetchApi(`/api/expenses/${id}/submit`, {
        method: 'PATCH',
      });
      notify.success('Expense submitted for approval');
      await loadData();
    } catch (err) {
      console.error('[Expenses] Submit error:', err);
      notify.error(err.message || 'Failed to submit expense');
    }
  };

  const approveExpense = async (id) => {
    try {
      const result = await fetchApi(`/api/expenses/${id}/approve`, {
        method: 'PATCH',
      });
      notify.success('Expense approved');
      await loadData();
    } catch (err) {
      console.error('[Expenses] Approve error:', err);
      notify.error(err.message || 'Failed to approve expense');
    }
  };

  const rejectExpense = async (id) => {
    const reason = prompt('Enter rejection reason (optional):');
    if (reason === null) return; // User cancelled
    try {
      const result = await fetchApi(`/api/expenses/${id}/reject`, {
        method: 'PATCH',
        body: JSON.stringify({ reason: reason || '' }),
      });
      notify.success('Expense rejected');
      await loadData();
    } catch (err) {
      console.error('[Expenses] Reject error:', err);
      notify.error(err.message || 'Failed to reject expense');
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
    if (!await notify.confirm('Delete this expense? This action cannot be undone.')) return;
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
    <div className="expenses-page" style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
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

      <div className="expenses-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr)', gap: '2rem' }}>

        {/* Create Expense Form */}
        <div className="card" style={{ padding: '2rem', height: 'fit-content' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={20} color="var(--accent-color)" /> New Expense
          </h3>
          <form onSubmit={(e) => createExpense(e, 'Pending')} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>
                Recipient Name <span style={{ color: '#ef4444' }}>*</span>
              </label>
              <input type="text" required className="input-field" placeholder="Enter recipient name"
                value={form.recipientName} onChange={e => setForm({ ...form, recipientName: e.target.value })} />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Description</label>
              <input type="text" className="input-field" placeholder="Enter description"
                value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>
                Category <span style={{ color: '#ef4444' }}>*</span>
              </label>
              <select className="input-field" value={form.category}
                onChange={e => setForm({ ...form, category: e.target.value })}
                style={{ background: 'var(--input-bg)' }}>
                {CATEGORY_OPTIONS.map(cat => <option key={cat} value={cat}>{cat}</option>)}
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>
                Amount ({currencySymbol()}) <span style={{ color: '#ef4444' }}>*</span>
              </label>
              <input type="number" step="0.01" min="0" required className="input-field" placeholder="Enter amount"
                value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>
                Transaction Date <span style={{ color: '#ef4444' }}>*</span>
              </label>
              <input type="date" required className="input-field" value={form.expenseDate}
                onChange={e => setForm({ ...form, expenseDate: e.target.value })} />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.75rem', color: 'var(--text-secondary)' }}>
                Payment Method <span style={{ color: '#ef4444' }}>*</span>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginLeft: '0.5rem' }}>
                  (split across one or more — total must equal Amount)
                </span>
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                {PAYMENT_METHODS.map(method => (
                  <div key={method}>
                    <label style={{ display: 'block', fontSize: '0.75rem', marginBottom: '0.3rem', color: 'var(--text-secondary)', textTransform: 'capitalize' }}>
                      {method === 'upi' ? 'UPI' : method}
                    </label>
                    <input type="number" step="0.01" min="0" className="input-field" placeholder="0.00"
                      value={form.payment[method]}
                      onChange={e => setForm({ ...form, payment: { ...form.payment, [method]: e.target.value } })} />
                  </div>
                ))}
              </div>
            </div>

            <button
              type="submit"
              className="btn-primary"
              style={{ padding: '1rem', width: '100%' }}
            >
              Submit for Approval
            </button>
          </form>
        </div>

        {/* Expenses Table */}
        <div className="card" style={{ padding: '2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1.5rem' }}>
            <h3 style={{ fontSize: '1.15rem', fontWeight: '600', margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Receipt size={20} color="var(--accent-color)" /> All Expenses
            </h3>
            {expenses.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <DateRangeFilter value={dateFilter} onChange={setDateFilter} label={null} />
                {visibleExpenses.length !== expenses.length && (
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    {visibleExpenses.length} of {expenses.length}
                  </span>
                )}
              </div>
            )}
          </div>

          {expenses.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>
              No expenses recorded yet.
            </p>
          ) : visibleExpenses.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>
              No expenses in the selected range.
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
                  {visibleExpenses.map(exp => (
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
                        {formatDate(exp.expenseDate)}
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem' }}>
                        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                          {exp.status === 'Draft' && (
                            <>
                              <button
                                onClick={() => submitExpense(exp.id)}
                                title="Submit"
                                style={{
                                  display: 'flex', alignItems: 'center', gap: '0.25rem',
                                  background: 'rgba(245,158,11,0.15)', color: '#f59e0b',
                                  border: '1px solid rgba(245,158,11,0.3)', borderRadius: '6px',
                                  padding: '0.3rem 0.6rem', fontSize: '0.7rem', fontWeight: '600',
                                  cursor: 'pointer', transition: '0.15s',
                                }}>
                                Submit
                              </button>
                            </>
                          )}
                          {exp.status === 'Pending' && (
                            <>
                              <button
                                onClick={() => approveExpense(exp.id)}
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
                                onClick={() => rejectExpense(exp.id)}
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

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        /* #513: collapse the 1fr 2fr two-column layout to a single stack on mobile.
           Same pattern as #478 (Tickets) and #480 (Tasks). minmax(0, ...) on the
           desktop grid prevents form-field min-content from forcing the column
           wider than 1fr would allow. */
        @media (max-width: 768px) {
          .expenses-page { padding: 1rem !important; }
          .expenses-grid { grid-template-columns: 1fr !important; gap: 1.25rem !important; }
          .expenses-page .card { padding: 1.25rem !important; }
        }
      `}</style>
    </div>
  );
}
