import React, { useState, useEffect, useMemo } from 'react';
import { FileSpreadsheet, Plus, Trash2, DollarSign, ArrowRightLeft, X } from 'lucide-react';
import { fetchApi } from '../utils/api';

const STATUS_CONFIG = {
  Draft:     { color: '#94a3b8', bg: 'rgba(148,163,184,0.15)' },
  Sent:      { color: '#3b82f6', bg: 'rgba(59,130,246,0.15)' },
  Accepted:  { color: '#10b981', bg: 'rgba(16,185,129,0.15)' },
  Rejected:  { color: '#ef4444', bg: 'rgba(239,68,68,0.15)' },
  Converted: { color: '#a855f7', bg: 'rgba(168,85,247,0.15)' },
};

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.Draft;
  return (
    <span style={{
      padding: '0.2rem 0.7rem', borderRadius: '999px', fontSize: '0.75rem',
      fontWeight: 'bold', backgroundColor: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.color}33`,
    }}>
      {status}
    </span>
  );
}

import { formatMoney, currencySymbol } from '../utils/money';
const formatCurrency = (v) => formatMoney(v, { maximumFractionDigits: 2, minimumFractionDigits: 2 });

const EMPTY_LINE_ITEM = { description: '', quantity: 1, unitPrice: 0 };

const INITIAL_FORM = {
  title: '',
  contactId: '',
  dealId: '',
  validUntil: '',
  notes: '',
};

export default function Estimates() {
  const [estimates, setEstimates] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [deals, setDeals] = useState([]);
  const [form, setForm] = useState(INITIAL_FORM);
  const [lineItems, setLineItems] = useState([{ ...EMPTY_LINE_ITEM }]);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [est, c, d] = await Promise.all([
        fetchApi('/api/estimates'),
        fetchApi('/api/contacts'),
        fetchApi('/api/deals'),
      ]);
      setEstimates(Array.isArray(est) ? est : []);
      setContacts(Array.isArray(c) ? c : []);
      setDeals(Array.isArray(d) ? d : []);
    } catch {
      // handled by fetchApi
    }
  };

  const stats = useMemo(() => {
    const draftCount = estimates.filter(e => e.status === 'Draft').length;
    const sentCount = estimates.filter(e => e.status === 'Sent').length;
    const totalValue = estimates.reduce((sum, e) => sum + Number(e.totalAmount), 0);
    return { draftCount, sentCount, totalValue };
  }, [estimates]);

  const grandTotal = useMemo(() =>
    lineItems.reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0), 0),
    [lineItems]
  );

  const handleFormChange = (field, value) => {
    setForm(prev => ({ ...prev, [field]: value }));
  };

  const handleLineItemChange = (index, field, value) => {
    setLineItems(prev => prev.map((item, i) =>
      i === index ? { ...item, [field]: value } : item
    ));
  };

  const addLineItem = () => {
    setLineItems(prev => [...prev, { ...EMPTY_LINE_ITEM }]);
  };

  const removeLineItem = (index) => {
    setLineItems(prev => prev.length <= 1 ? prev : prev.filter((_, i) => i !== index));
  };

  const createEstimate = async (e) => {
    e.preventDefault();
    try {
      await fetchApi('/api/estimates', {
        method: 'POST',
        body: JSON.stringify({
          title: form.title,
          contactId: form.contactId || undefined,
          dealId: form.dealId || undefined,
          validUntil: form.validUntil || undefined,
          notes: form.notes || undefined,
          lineItems: lineItems.filter(item => item.description.trim()),
        }),
      });
      setForm(INITIAL_FORM);
      setLineItems([{ ...EMPTY_LINE_ITEM }]);
      loadData();
    } catch {
      alert('Failed to create estimate');
    }
  };

  const convertToInvoice = async (id) => {
    if (!window.confirm('Convert this estimate to an invoice?')) return;
    try {
      await fetchApi(`/api/estimates/${id}/convert`, { method: 'PUT' });
      loadData();
    } catch {
      alert('Failed to convert estimate. Make sure the estimate has a contact assigned.');
    }
  };

  const deleteEstimate = async (id) => {
    if (!window.confirm('Delete this estimate? This cannot be undone.')) return;
    try {
      await fetchApi(`/api/estimates/${id}`, { method: 'DELETE' });
      loadData();
    } catch {
      alert('Failed to delete estimate');
    }
  };

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <FileSpreadsheet size={26} color="var(--accent-color)" /> Estimates
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          Create estimates, manage line items, and convert to invoices.
        </p>
      </header>

      {/* Summary Stats */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.75rem', flexWrap: 'wrap' }}>
        <span style={{
          padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: '600',
          background: 'rgba(148,163,184,0.1)', color: '#94a3b8', border: '1px solid rgba(148,163,184,0.3)',
          display: 'flex', alignItems: 'center', gap: '0.4rem',
        }}>
          {stats.draftCount} Drafts
        </span>
        <span style={{
          padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: '600',
          background: 'rgba(59,130,246,0.1)', color: '#3b82f6', border: '1px solid rgba(59,130,246,0.3)',
          display: 'flex', alignItems: 'center', gap: '0.4rem',
        }}>
          {stats.sentCount} Sent
        </span>
        <span style={{
          padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: '600',
          background: 'rgba(16,185,129,0.1)', color: '#10b981', border: '1px solid rgba(16,185,129,0.3)',
          display: 'flex', alignItems: 'center', gap: '0.4rem',
        }}>
          <DollarSign size={14} /> Total Value: {formatCurrency(stats.totalValue)}
        </span>
        <span style={{
          padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem',
          background: 'rgba(255,255,255,0.04)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)',
        }}>
          {estimates.length} total estimates
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '2rem' }}>

        {/* Create Estimate Panel */}
        <div className="card" style={{ padding: '2rem', height: 'fit-content' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={20} color="var(--accent-color)" /> Create Estimate
          </h3>
          <form onSubmit={createEstimate} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Title</label>
              <input
                type="text"
                className="input-field"
                required
                placeholder="Estimate title"
                value={form.title}
                onChange={e => handleFormChange('title', e.target.value)}
                aria-label="Estimate title"
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Contact</label>
              <select
                className="input-field"
                value={form.contactId}
                onChange={e => handleFormChange('contactId', e.target.value)}
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
                value={form.dealId}
                onChange={e => handleFormChange('dealId', e.target.value)}
                style={{ background: 'var(--input-bg)' }}
                aria-label="Associated deal"
              >
                <option value="">-- No Deal --</option>
                {deals.map(d => (
                  <option key={d.id} value={d.id}>{d.title} - {formatCurrency(d.amount)}</option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Valid Until</label>
              <input
                type="date"
                className="input-field"
                value={form.validUntil}
                onChange={e => handleFormChange('validUntil', e.target.value)}
                aria-label="Valid until date"
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Notes</label>
              <textarea
                className="input-field"
                rows={3}
                placeholder="Additional notes..."
                value={form.notes}
                onChange={e => handleFormChange('notes', e.target.value)}
                style={{ resize: 'vertical' }}
                aria-label="Estimate notes"
              />
            </div>

            {/* Line Items */}
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.75rem', color: 'var(--text-secondary)' }}>Line Items</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {lineItems.map((item, index) => (
                  <div key={index} style={{
                    display: 'flex', gap: '0.5rem', alignItems: 'flex-end',
                    padding: '0.75rem', borderRadius: '8px',
                    background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)',
                  }}>
                    <div style={{ flex: 2 }}>
                      <label style={{ display: 'block', fontSize: '0.7rem', marginBottom: '0.25rem', color: 'var(--text-secondary)' }}>Description</label>
                      <input
                        type="text"
                        className="input-field"
                        placeholder="Item description"
                        value={item.description}
                        onChange={e => handleLineItemChange(index, 'description', e.target.value)}
                        aria-label={`Line item ${index + 1} description`}
                      />
                    </div>
                    <div style={{ flex: 0.5 }}>
                      <label style={{ display: 'block', fontSize: '0.7rem', marginBottom: '0.25rem', color: 'var(--text-secondary)' }}>Qty</label>
                      <input
                        type="number"
                        min="1"
                        className="input-field"
                        value={item.quantity}
                        onChange={e => handleLineItemChange(index, 'quantity', e.target.value)}
                        aria-label={`Line item ${index + 1} quantity`}
                      />
                    </div>
                    <div style={{ flex: 0.75 }}>
                      <label style={{ display: 'block', fontSize: '0.7rem', marginBottom: '0.25rem', color: 'var(--text-secondary)' }}>Unit Price</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        className="input-field"
                        value={item.unitPrice}
                        onChange={e => handleLineItemChange(index, 'unitPrice', e.target.value)}
                        aria-label={`Line item ${index + 1} unit price`}
                      />
                    </div>
                    <div style={{ flex: 0.5, textAlign: 'right' }}>
                      <label style={{ display: 'block', fontSize: '0.7rem', marginBottom: '0.25rem', color: 'var(--text-secondary)' }}>Total</label>
                      <span style={{ fontSize: '0.85rem', fontWeight: '600', color: '#10b981' }}>
                        {formatCurrency((Number(item.quantity) || 0) * (Number(item.unitPrice) || 0))}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeLineItem(index)}
                      style={{
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        color: 'var(--text-secondary)', padding: '0.3rem',
                      }}
                      aria-label={`Remove line item ${index + 1}`}
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={addLineItem}
                style={{
                  marginTop: '0.75rem', background: 'transparent',
                  border: '1px dashed var(--border-color)', color: 'var(--accent-color)',
                  padding: '0.5rem 1rem', borderRadius: '6px', cursor: 'pointer',
                  fontSize: '0.8rem', width: '100%',
                }}
              >
                + Add Line Item
              </button>

              {/* Grand Total */}
              <div style={{
                marginTop: '1rem', padding: '0.75rem 1rem', borderRadius: '8px',
                background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <span style={{ fontWeight: '600', fontSize: '0.9rem' }}>Grand Total</span>
                <span style={{ fontWeight: 'bold', fontSize: '1.1rem', color: '#10b981' }}>
                  {formatCurrency(grandTotal)}
                </span>
              </div>
            </div>

            <button type="submit" className="btn-primary" style={{ padding: '1rem', marginTop: '0.5rem' }}>
              Create Estimate
            </button>
          </form>
        </div>

        {/* Estimates Table */}
        <div className="card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <FileSpreadsheet size={20} color="var(--success-color)" /> Estimate Ledger
          </h3>

          {estimates.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '4rem 2rem', background: 'rgba(255,255,255,0.01)', border: '1px dashed var(--border-color)', borderRadius: '8px' }}>
              <FileSpreadsheet size={48} style={{ opacity: 0.2, margin: '0 auto 1rem', color: 'var(--accent-color)' }} />
              <p style={{ color: 'var(--text-secondary)' }}>No estimates yet. Create one to get started.</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }} role="table" aria-label="Estimates table">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                    {['Est #', 'Title', 'Contact', 'Total', 'Status', 'Valid Until', 'Items', 'Actions'].map(h => (
                      <th key={h} style={{
                        padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600',
                        fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em',
                        ...(h === 'Actions' ? { textAlign: 'right' } : {}),
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {estimates.map(est => (
                    <tr
                      key={est.id}
                      style={{ borderBottom: '1px solid var(--border-color)', transition: 'background 0.15s' }}
                      onMouseOver={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                      onMouseOut={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <td style={{ padding: '1rem 0.5rem', fontWeight: '600', letterSpacing: '0.03em' }}>
                        {est.estimateNum}
                      </td>
                      <td style={{ padding: '1rem 0.5rem' }}>{est.title}</td>
                      <td style={{ padding: '1rem 0.5rem', color: 'var(--text-secondary)' }}>
                        {est.contact?.name || '-'}
                      </td>
                      <td style={{ padding: '1rem 0.5rem' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                          <DollarSign size={14} color="var(--success-color)" />
                          {formatCurrency(est.totalAmount)}
                        </span>
                      </td>
                      <td style={{ padding: '1rem 0.5rem' }}>
                        <StatusBadge status={est.status} />
                      </td>
                      <td style={{ padding: '1rem 0.5rem', color: 'var(--text-secondary)' }}>
                        {est.validUntil ? new Date(est.validUntil).toLocaleDateString() : '-'}
                      </td>
                      <td style={{ padding: '1rem 0.5rem', color: 'var(--text-secondary)' }}>
                        {est.lineItems?.length || 0}
                      </td>
                      <td style={{ padding: '1rem 0.5rem', textAlign: 'right' }}>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                          {est.status !== 'Converted' && (
                            <button
                              onClick={() => convertToInvoice(est.id)}
                              style={{
                                display: 'flex', alignItems: 'center', gap: '0.3rem',
                                background: 'rgba(168,85,247,0.15)', color: '#a855f7', border: '1px solid rgba(168,85,247,0.3)',
                                padding: '0.4rem 0.75rem', fontSize: '0.8rem', borderRadius: '6px',
                                cursor: 'pointer',
                              }}
                              aria-label={`Convert estimate ${est.estimateNum} to invoice`}
                            >
                              <ArrowRightLeft size={14} /> Convert
                            </button>
                          )}
                          <button
                            onClick={() => deleteEstimate(est.id)}
                            style={{
                              background: 'transparent', border: '1px solid rgba(239,68,68,0.3)',
                              color: 'var(--text-secondary)', cursor: 'pointer',
                              display: 'flex', alignItems: 'center', gap: '0.3rem',
                              fontSize: '0.8rem', padding: '0.4rem 0.75rem', borderRadius: '6px',
                            }}
                            onMouseOver={e => e.currentTarget.style.color = '#ef4444'}
                            onMouseOut={e => e.currentTarget.style.color = 'var(--text-secondary)'}
                            aria-label={`Delete estimate ${est.estimateNum}`}
                          >
                            <Trash2 size={14} /> Delete
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
