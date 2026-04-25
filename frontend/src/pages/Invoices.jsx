import React, { useState, useEffect, useMemo } from 'react';
import { Receipt, Plus, CheckCircle2, Trash2, DollarSign, Clock, AlertTriangle, Download, RefreshCw } from 'lucide-react';
import { fetchApi } from '../utils/api';

const STATUS_CONFIG = {
  PAID:    { color: '#10b981', bg: 'rgba(16,185,129,0.15)', label: 'Paid' },
  UNPAID:  { color: '#f59e0b', bg: 'rgba(245,158,11,0.15)', label: 'Unpaid' },
  OVERDUE: { color: '#ef4444', bg: 'rgba(239,68,68,0.15)', label: 'Overdue' },
  VOIDED:  { color: '#6b7280', bg: 'rgba(107,114,128,0.15)', label: 'Voided' },
};

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.UNPAID;
  return (
    <span style={{
      padding: '0.2rem 0.7rem', borderRadius: '999px', fontSize: '0.75rem',
      fontWeight: 'bold', backgroundColor: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.color}33`,
    }}>
      {cfg.label}
    </span>
  );
}

import { formatMoney, currencySymbol } from '../utils/money';
const formatCurrency = (v) => formatMoney(v, { maximumFractionDigits: 2, minimumFractionDigits: 2 });

export default function Invoices() {
  const [invoices, setInvoices] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [deals, setDeals] = useState([]);
  const [newInvoice, setNewInvoice] = useState({
    invoiceNum: '',
    contactId: '',
    dealId: '',
    amount: '',
    dueDate: '',
    status: 'UNPAID',
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [invs, c, d] = await Promise.all([
        fetchApi('/api/billing'),
        fetchApi('/api/contacts'),
        fetchApi('/api/deals'),
      ]);
      setInvoices(Array.isArray(invs) ? invs : []);
      setContacts(Array.isArray(c) ? c : []);
      setDeals(Array.isArray(d) ? d : []);
    } catch (err) {
      // Network or auth error handled by fetchApi
    }
  };

  const stats = useMemo(() => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const totalOutstanding = invoices
      .filter(inv => inv.status !== 'PAID' && inv.status !== 'VOIDED')
      .reduce((sum, inv) => sum + Number(inv.amount), 0);

    const totalPaidThisMonth = invoices
      .filter(inv => inv.status === 'PAID' && new Date(inv.updatedAt || inv.createdAt) >= startOfMonth)
      .reduce((sum, inv) => sum + Number(inv.amount), 0);

    const overdueCount = invoices.filter(inv => inv.status === 'OVERDUE').length;

    return { totalOutstanding, totalPaidThisMonth, overdueCount };
  }, [invoices]);

  const nextInvoiceNum = useMemo(() => {
    if (invoices.length === 0) return 'INV-001';
    const nums = invoices
      .map(inv => {
        const match = (inv.invoiceNum || '').match(/INV-(\d+|[A-F0-9]+)/i);
        return match ? parseInt(match[1], 16) : 0;
      })
      .filter(n => !isNaN(n));
    const max = nums.length > 0 ? Math.max(...nums) : 0;
    return `INV-${String(max + 1).padStart(3, '0')}`;
  }, [invoices]);

  const handleFieldChange = (field, value) => {
    setNewInvoice(prev => ({ ...prev, [field]: value }));
  };

  const createInvoice = async (e) => {
    e.preventDefault();
    try {
      await fetchApi('/api/billing', {
        method: 'POST',
        body: JSON.stringify({
          amount: newInvoice.amount,
          dueDate: newInvoice.dueDate,
          contactId: newInvoice.contactId,
          dealId: newInvoice.dealId || undefined,
        }),
      });
      setNewInvoice({ invoiceNum: '', contactId: '', dealId: '', amount: '', dueDate: '', status: 'UNPAID' });
      loadData();
    } catch (err) {
      alert('Failed to create invoice');
    }
  };

  const markPaid = async (id) => {
    try {
      await fetchApi(`/api/billing/${id}/pay`, { method: 'PUT' });
      loadData();
    } catch (err) {
      alert('Failed to mark invoice as paid');
    }
  };

  const downloadPdf = (id, invoiceNum) => {
    const token = localStorage.getItem('token');
    const baseUrl = import.meta.env.VITE_API_URL || '';
    const url = `${baseUrl}/api/billing/${id}/pdf`;
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(res => {
        if (!res.ok) throw new Error('PDF generation failed');
        return res.blob();
      })
      .then(blob => {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${invoiceNum || 'invoice'}.pdf`;
        link.click();
        URL.revokeObjectURL(link.href);
      })
      .catch(() => alert('Failed to download PDF'));
  };

  const voidInvoice = async (inv) => {
    const num = inv.invoiceNum || `#${inv.id}`;
    if (!window.confirm(
      `Void invoice ${num}?\n\n` +
      `This marks the invoice as VOIDED and removes it from Outstanding totals. ` +
      `The invoice row and audit trail are preserved (no data loss).`
    )) return;
    try {
      await fetchApi(`/api/billing/${inv.id}/void`, { method: 'PUT' });
      loadData();
    } catch (err) {
      alert('Failed to void invoice');
    }
  };

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Receipt size={26} color="var(--accent-color)" /> Invoices
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          Create, track, and manage all invoices across your accounts.
        </p>
      </header>

      {/* Summary Stats */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.75rem', flexWrap: 'wrap' }}>
        <span style={{
          padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: '600',
          background: 'rgba(245,158,11,0.1)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.3)',
          display: 'flex', alignItems: 'center', gap: '0.4rem',
        }}>
          <DollarSign size={14} /> Outstanding: {formatCurrency(stats.totalOutstanding)}
        </span>
        <span style={{
          padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: '600',
          background: 'rgba(16,185,129,0.1)', color: '#10b981', border: '1px solid rgba(16,185,129,0.3)',
          display: 'flex', alignItems: 'center', gap: '0.4rem',
        }}>
          <CheckCircle2 size={14} /> Paid This Month: {formatCurrency(stats.totalPaidThisMonth)}
        </span>
        {stats.overdueCount > 0 && (
          <span style={{
            padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: '600',
            background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)',
            display: 'flex', alignItems: 'center', gap: '0.4rem',
          }}>
            <AlertTriangle size={14} /> {stats.overdueCount} Overdue
          </span>
        )}
        <span style={{
          padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem',
          background: 'var(--subtle-bg-4)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)',
        }}>
          {invoices.length} total invoices
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '2rem' }}>

        {/* Create Invoice Panel */}
        <div className="card" style={{ padding: '2rem', height: 'fit-content' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={20} color="var(--accent-color)" /> Create Invoice
          </h3>
          <form onSubmit={createInvoice} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Invoice #</label>
              <input
                type="text"
                className="input-field"
                placeholder={nextInvoiceNum}
                value={newInvoice.invoiceNum}
                onChange={e => handleFieldChange('invoiceNum', e.target.value)}
                aria-label="Invoice number"
              />
              <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.25rem', display: 'block' }}>
                Auto-generated if left blank
              </span>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Contact</label>
              <select
                className="input-field"
                required
                value={newInvoice.contactId}
                onChange={e => handleFieldChange('contactId', e.target.value)}
                style={{ background: 'var(--input-bg)' }}
                aria-label="Contact"
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
                value={newInvoice.dealId}
                onChange={e => handleFieldChange('dealId', e.target.value)}
                style={{ background: 'var(--input-bg)' }}
                aria-label="Associated deal"
              >
                <option value="">-- No Deal --</option>
                {deals.map(d => (
                  <option key={d.id} value={d.id}>{d.title} - {formatCurrency(d.amount)}</option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', gap: '1rem' }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Amount ({currencySymbol()})</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  className="input-field"
                  placeholder="0.00"
                  value={newInvoice.amount}
                  onChange={e => handleFieldChange('amount', e.target.value)}
                  aria-label="Invoice amount"
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Due Date</label>
                <input
                  type="date"
                  required
                  className="input-field"
                  value={newInvoice.dueDate}
                  onChange={e => handleFieldChange('dueDate', e.target.value)}
                  aria-label="Due date"
                />
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Status</label>
              <select
                className="input-field"
                value={newInvoice.status}
                onChange={e => handleFieldChange('status', e.target.value)}
                style={{ background: 'var(--input-bg)' }}
                aria-label="Invoice status"
              >
                <option value="UNPAID">Unpaid</option>
                <option value="PAID">Paid</option>
                <option value="OVERDUE">Overdue</option>
              </select>
            </div>

            <button type="submit" className="btn-primary" style={{ padding: '1rem', marginTop: '0.5rem' }}>
              Issue Invoice
            </button>
          </form>
        </div>

        {/* Invoice Table */}
        <div className="card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Receipt size={20} color="var(--success-color)" /> Invoice Ledger
          </h3>

          {invoices.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '4rem 2rem', background: 'var(--subtle-bg-2)', border: '1px dashed var(--border-color)', borderRadius: '8px' }}>
              <Receipt size={48} style={{ opacity: 0.2, margin: '0 auto 1rem', color: 'var(--accent-color)' }} />
              <p style={{ color: 'var(--text-secondary)' }}>No invoices yet. Create one to get started.</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }} role="table" aria-label="Invoices table">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Invoice #</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Amount</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Status</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Due Date</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Issued</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Contact</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map(inv => (
                    <tr
                      key={inv.id}
                      style={{
                        borderBottom: '1px solid var(--border-color)',
                        transition: 'background 0.15s',
                      }}
                      onMouseOver={e => e.currentTarget.style.background = 'var(--hover-bg)'}
                      onMouseOut={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <td style={{ padding: '1rem 0.5rem', fontWeight: '600', letterSpacing: '0.03em' }}>
                        {inv.invoiceNum}
                      </td>
                      <td style={{ padding: '1rem 0.5rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <DollarSign size={14} color="var(--success-color)" />
                        {formatCurrency(inv.amount)}
                      </td>
                      <td style={{ padding: '1rem 0.5rem' }}>
                        <StatusBadge status={inv.status} />
                      </td>
                      <td style={{ padding: '1rem 0.5rem', color: 'var(--text-secondary)' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                          <Clock size={13} />
                          {new Date(inv.dueDate).toLocaleDateString()}
                        </span>
                      </td>
                      <td style={{ padding: '1rem 0.5rem', color: 'var(--text-secondary)' }}>
                        {new Date(inv.createdAt).toLocaleDateString()}
                      </td>
                      <td style={{ padding: '1rem 0.5rem', color: 'var(--text-secondary)' }}>
                        {inv.contact?.name || 'Unknown'}
                      </td>
                      <td style={{ padding: '1rem 0.5rem', textAlign: 'right' }}>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                          <button
                            onClick={() => downloadPdf(inv.id, inv.invoiceNum)}
                            style={{
                              background: 'transparent', border: '1px solid rgba(59,130,246,0.3)',
                              color: 'var(--text-secondary)', cursor: 'pointer',
                              display: 'flex', alignItems: 'center', gap: '0.3rem',
                              fontSize: '0.8rem', padding: '0.4rem 0.75rem', borderRadius: '6px',
                            }}
                            onMouseOver={e => e.currentTarget.style.color = '#3b82f6'}
                            onMouseOut={e => e.currentTarget.style.color = 'var(--text-secondary)'}
                            aria-label={`Download PDF for invoice ${inv.invoiceNum}`}
                          >
                            <Download size={14} /> PDF
                          </button>
                          {inv.status !== 'PAID' && inv.status !== 'VOIDED' && (
                            <button
                              onClick={() => markPaid(inv.id)}
                              className="btn-secondary"
                              style={{
                                display: 'flex', alignItems: 'center', gap: '0.3rem',
                                background: 'var(--success-color)', color: '#fff', border: 'none',
                                padding: '0.4rem 0.75rem', fontSize: '0.8rem', borderRadius: '6px',
                                cursor: 'pointer',
                              }}
                              aria-label={`Mark invoice ${inv.invoiceNum} as paid`}
                            >
                              <CheckCircle2 size={14} /> Mark Paid
                            </button>
                          )}
                          <button
                            onClick={async () => {
                              const freq = inv.isRecurring ? null : prompt('Recurring frequency: monthly, quarterly, or yearly', 'monthly');
                              if (!inv.isRecurring && !freq) return;
                              await fetchApi(`/api/billing/${inv.id}/recurring`, {
                                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ isRecurring: !inv.isRecurring, recurFrequency: freq })
                              });
                              loadData();
                            }}
                            style={{
                              background: inv.isRecurring ? 'rgba(139,92,246,0.1)' : 'transparent',
                              border: `1px solid ${inv.isRecurring ? 'rgba(139,92,246,0.3)' : 'var(--border-color)'}`,
                              color: inv.isRecurring ? '#8b5cf6' : 'var(--text-secondary)', cursor: 'pointer',
                              display: 'flex', alignItems: 'center', gap: '0.3rem',
                              fontSize: '0.8rem', padding: '0.4rem 0.75rem', borderRadius: '6px',
                            }}
                          >
                            <RefreshCw size={14} /> {inv.isRecurring ? `${inv.recurFrequency}` : 'Recur'}
                          </button>
                          {inv.status !== 'VOIDED' && (
                            <button
                              onClick={() => voidInvoice(inv)}
                              style={{
                                background: 'transparent', border: '1px solid rgba(239,68,68,0.3)',
                                color: 'var(--text-secondary)', cursor: 'pointer',
                                display: 'flex', alignItems: 'center', gap: '0.3rem',
                                fontSize: '0.8rem', padding: '0.4rem 0.75rem', borderRadius: '6px',
                              }}
                              onMouseOver={e => e.currentTarget.style.color = '#ef4444'}
                              onMouseOut={e => e.currentTarget.style.color = 'var(--text-secondary)'}
                              aria-label={`Void invoice ${inv.invoiceNum}`}
                            >
                              <Trash2 size={14} /> Void
                            </button>
                          )}
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
