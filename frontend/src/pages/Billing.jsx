import React, { useState, useEffect } from 'react';
import { CreditCard, Plus, CheckCircle2, Clock, Trash2, FileText, DollarSign } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

export default function Billing() {
  const notify = useNotify();
  const [invoices, setInvoices] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [deals, setDeals] = useState([]);
  
  const [newInvoice, setNewInvoice] = useState({ amount: '', dueDate: '', contactId: '', dealId: '' });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const invs = await fetchApi('/api/billing');
      setInvoices(Array.isArray(invs) ? invs : []);
      
      const c = await fetchApi('/api/contacts');
      setContacts(Array.isArray(c) ? c : []);
      
      const d = await fetchApi('/api/deals');
      setDeals(Array.isArray(d) ? d : []);
    } catch (err) {
      console.error(err);
    }
  };

  const constructInvoice = async (e) => {
    e.preventDefault();
    try {
      await fetchApi('/api/billing', { method: 'POST', body: JSON.stringify(newInvoice) });
      setNewInvoice({ amount: '', dueDate: '', contactId: '', dealId: '' });
      loadData();
    } catch(err) {
      notify.error("Failed to issue invoice");
    }
  };

  const markPaid = async (id) => {
    await fetchApi(`/api/billing/${id}/pay`, { method: 'PUT' });
    loadData();
  };

  const deleteInvoice = async (id) => {
    const ok = await notify.confirm({
      title: 'Void ledger entry',
      message: 'WARNING: Are you absolutely certain you wish to void this ledger entry? This cannot be undone.',
      confirmText: 'Void',
      destructive: true,
    });
    if (!ok) return;
    await fetchApi(`/api/billing/${id}`, { method: 'DELETE' });
    loadData();
  };

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2.5rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 'bold' }}>Global Billing & Invoicing</h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Issue payment links, reconcile accounts receivable, and oversee monetary capture.</p>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(380px, 1fr) 2fr', gap: '2rem' }}>
        
        {/* Issue Invoice Panel */}
        <div className="card" style={{ padding: '2rem', height: 'fit-content' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={20} color="var(--accent-color)" /> Issue Official Invoice
          </h3>
          <form onSubmit={constructInvoice} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Billed Entity (Contact Profile)</label>
              <select className="input-field" required value={newInvoice.contactId} onChange={e => setNewInvoice({...newInvoice, contactId: e.target.value})} style={{ background: 'var(--input-bg)' }}>
                <option value="">-- Select Contact --</option>
                {contacts.map(c => <option key={c.id} value={c.id}>{c.name} ({c.email})</option>)}
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Associate Deal Track (Optional)</label>
              <select className="input-field" value={newInvoice.dealId} onChange={e => setNewInvoice({...newInvoice, dealId: e.target.value})} style={{ background: 'var(--input-bg)' }}>
                <option value="">-- Standalone Invoice --</option>
                {deals.map(d => <option key={d.id} value={d.id}>{d.title} - ${d.amount.toLocaleString()}</option>)}
              </select>
            </div>

            <div style={{ display: 'flex', gap: '1rem' }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Amount ($)</label>
                <input type="number" step="0.01" required className="input-field" placeholder="0.00" value={newInvoice.amount} onChange={e => setNewInvoice({...newInvoice, amount: e.target.value})} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Payment Deadline</label>
                <input type="date" required className="input-field" value={newInvoice.dueDate} onChange={e => setNewInvoice({...newInvoice, dueDate: e.target.value})} />
              </div>
            </div>

            <button type="submit" className="btn-primary" style={{ marginTop: '0.75rem', padding: '1rem' }}>Generate & Issue Document</button>
          </form>
        </div>

        {/* Ledger */}
        <div className="card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <FileText size={20} color="var(--success-color)" /> Accounts Receivable Ledger
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {invoices.map(inv => (
              <div key={inv.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1.5rem', background: 'var(--subtle-bg-2)', border: '1px solid var(--border-color)', borderRadius: '8px', transition: 'transform 0.2s', ':hover': { transform: 'scale(1.01)'} }}>
                
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.75rem' }}>
                    <h4 style={{ fontWeight: '600', fontSize: '1.1rem', color: 'var(--text-primary)', letterSpacing: '0.05em' }}>{inv.invoiceNum}</h4>
                    <span style={{ 
                      fontSize: '0.75rem', padding: '0.25rem 0.75rem', borderRadius: '12px', fontWeight: 'bold',
                      background: inv.status === 'PAID' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                      color: inv.status === 'PAID' ? '#10b981' : '#ef4444' 
                    }}>
                      {inv.status}
                    </span>
                  </div>
                  
                  <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                    Billed to: <strong style={{ color: 'var(--text-primary)' }}>{inv.contact?.name || 'Unknown Entity'}</strong>
                    {inv.deal && ` • Track: ${inv.deal.title}`}
                  </p>
                  
                  <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Clock size={16} color="var(--accent-color)" /> Deadline: {new Date(inv.dueDate).toLocaleDateString()}
                  </p>
                </div>
                
                <div style={{ display: 'flex', alignItems: 'center', gap: '2.5rem' }}>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ fontSize: '1.75rem', fontWeight: 'bold', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <DollarSign size={24} color="var(--success-color)" />
                      {inv.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                  
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {inv.status !== 'PAID' && (
                      <button onClick={() => markPaid(inv.id)} className="btn-secondary" style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', background: 'var(--success-color)', color: '#fff', border: 'none', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <CheckCircle2 size={16} /> Mark Paid
                      </button>
                    )}
                    <button onClick={() => deleteInvoice(inv.id)} style={{ background: 'transparent', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--text-secondary)', cursor: 'pointer', textAlign: 'right', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '0.25rem', fontSize: '0.875rem', padding: '0.4rem 0.75rem', borderRadius: '6px', position: 'relative', zIndex: 10, pointerEvents: 'all' }} onMouseOver={(e) => e.currentTarget.style.color = '#ef4444'} onMouseOut={(e) => e.currentTarget.style.color = 'var(--text-secondary)'}>
                      <Trash2 size={16} /> Void
                    </button>
                  </div>
                </div>

              </div>
            ))}
            
            {invoices.length === 0 && (
              <div style={{ textAlign: 'center', padding: '4rem 2rem', background: 'var(--subtle-bg-2)', border: '1px dashed var(--border-color)', borderRadius: '8px' }}>
                <CreditCard size={48} style={{ opacity: 0.2, margin: '0 auto 1rem', color: 'var(--accent-color)' }} />
                <p style={{ color: 'var(--text-secondary)' }}>The financial ledger is currently isolated and idle.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
