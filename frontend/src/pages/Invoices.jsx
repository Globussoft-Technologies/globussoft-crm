import React, { useState, useEffect, useMemo } from 'react';
import { Receipt, Plus, CheckCircle2, Trash2, DollarSign, Clock, AlertTriangle, Download, RefreshCw, CreditCard, X, Filter } from 'lucide-react';
import { fetchApi, getAuthToken } from '../utils/api';
import { useNotify } from '../utils/notify';

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
import { formatDate } from '../utils/date';
const formatCurrency = (v) => formatMoney(v, { maximumFractionDigits: 2, minimumFractionDigits: 2 });

export default function Invoices() {
  const notify = useNotify();
  const [invoices, setInvoices] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [deals, setDeals] = useState([]);
  const [paymentConfig, setPaymentConfig] = useState({ stripe: { configured: false }, razorpay: { configured: false } });
  const [newInvoice, setNewInvoice] = useState({
    invoiceNum: '',
    contactId: '',
    dealId: '',
    amount: '',
    dueDate: '',
    status: 'UNPAID',
  });
  // #124: replace the old prompt() flow with a proper modal so the user can
  // pick frequency, see what they're about to activate, and stop recurring
  // explicitly instead of guessing the toggle.
  const [recurInvoice, setRecurInvoice] = useState(null);
  const [recurFreq, setRecurFreq] = useState('monthly');
  const [paymentModal, setPaymentModal] = useState(null);
  const [paymentGateway, setPaymentGateway] = useState('razorpay');
  const [processingPayment, setProcessingPayment] = useState(false);
  const [statusFilter, setStatusFilter] = useState('ALL');
  // #894 — Create Invoice surface is a header CTA + drawer (not the inline
  // always-visible left-column form). `creating` drives whether the drawer
  // is rendered. Mirrors the c031ba0 / 50ac575 pattern from /leads.
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadData();
    loadPaymentConfig();
  }, []);

  // #894 — close the Create drawer on Escape. Attached only while the
  // drawer is open so we don't trap key events for users not actively
  // creating an invoice.
  useEffect(() => {
    if (!creating) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setCreating(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [creating]);

  const openCreate = () => setCreating(true);
  const closeCreate = () => setCreating(false);

  const loadPaymentConfig = async () => {
    try {
      const config = await fetchApi('/api/payments/config');
      setPaymentConfig(config);
      // Set default to available gateway
      if (config.razorpay?.configured) {
        setPaymentGateway('razorpay');
      } else if (config.stripe?.configured) {
        setPaymentGateway('stripe');
      }
    } catch (err) {
      console.error('Failed to load payment config:', err);
    }
  };

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

    // #119: filter on paidAt (set by /pay route). Fall back to issuedDate for legacy
    // rows from before paidAt existed — at worst they count toward the issuance month
    // rather than the (unknown) payment month.
    const totalPaidThisMonth = invoices
      .filter(inv => inv.status === 'PAID' && new Date(inv.paidAt || inv.issuedDate) >= startOfMonth)
      .reduce((sum, inv) => sum + Number(inv.amount), 0);

    const overdueCount = invoices.filter(inv => inv.status === 'OVERDUE').length;

    return { totalOutstanding, totalPaidThisMonth, overdueCount };
  }, [invoices]);

  const filteredInvoices = useMemo(() => {
    if (statusFilter === 'ALL') return invoices;
    return invoices.filter(inv => inv.status === statusFilter);
  }, [invoices, statusFilter]);

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
      // #894 — close the drawer on successful create; the list refresh
      // below puts the new row at the top so the user sees the result.
      setCreating(false);
      loadData();
    } catch (err) {
      notify.error('Failed to create invoice');
    }
  };

  const markPaid = async (id) => {
    try {
      await fetchApi(`/api/billing/${id}/pay`, { method: 'PUT' });
      // #119: must refetch so the "Paid This Month" KPI memo recomputes from
      // the freshly-paid row (with paidAt populated server-side). Awaiting the
      // refetch keeps the Outstanding/Paid totals consistent with what the
      // user sees in the table.
      await loadData();
    } catch (err) {
      notify.error('Failed to mark invoice as paid');
    }
  };

  const downloadPdf = (id, invoiceNum) => {
    const token = getAuthToken();
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
      .catch(() => notify.error('Failed to download PDF'));
  };

  const voidInvoice = async (inv) => {
    const num = inv.invoiceNum || `#${inv.id}`;
    if (!await notify.confirm({
      title: `Void invoice ${num}?`,
      message:
        `This marks the invoice as VOIDED and removes it from Outstanding totals. ` +
        `The invoice row and audit trail are preserved (no data loss).`,
      confirmText: 'Void',
      destructive: true,
    })) return;
    try {
      await fetchApi(`/api/billing/${inv.id}/void`, { method: 'PUT' });
      loadData();
    } catch (err) {
      notify.error('Failed to void invoice');
    }
  };

  const initiatePayment = (inv) => {
    setPaymentModal(inv);
  };

  const openRazorpayCheckout = async (paymentData, invoice) => {
    try {
      // Use key from order response first, then fallback to config
      const razorpayKeyId = paymentData.key || paymentConfig.razorpay?.keyId;
      console.log('[Payment] Razorpay Key ID:', razorpayKeyId);
      console.log('[Payment] Order ID:', paymentData.orderId);
      console.log('[Payment] Full payment data:', paymentData);

      if (!razorpayKeyId) {
        notify.error('⚠️ Razorpay public key not configured. Key: ' + JSON.stringify(paymentData));
        setProcessingPayment(false);
        return;
      }

      if (!paymentData.orderId) {
        notify.error('⚠️ Payment order creation failed');
        setProcessingPayment(false);
        return;
      }

      const options = {
        key: razorpayKeyId,
        order_id: paymentData.orderId,
        amount: Math.round(invoice.amount * 100),
        currency: 'INR',
        name: 'Invoice Payment',
        description: `Invoice ${invoice.invoiceNum}`,
        handler: async (response) => {
          console.log('[Payment] Razorpay response received:', response);
          try {
            const verifyResponse = await fetchApi('/api/payments/confirm-razorpay', {
              method: 'POST',
              body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
                paymentId: paymentData.paymentId,
              }),
            });

            console.log('[Payment] Verification response:', verifyResponse);
            if (verifyResponse?.success) {
              notify.success(`✓ Payment successful! Invoice ${invoice.invoiceNum} marked as PAID.`);
              setPaymentModal(null);
              await loadData();
            } else {
              notify.error(`Payment verification failed: ${verifyResponse?.error || 'Unknown error'}`);
            }
          } catch (err) {
            console.error('[Payment] Verification error:', err);
            notify.error(`Verification failed: ${err.message}`);
          } finally {
            setProcessingPayment(false);
          }
        },
        prefill: {
          name: invoice.contact?.name || 'Customer',
          email: invoice.contact?.email || 'customer@example.com',
        },
        theme: { color: '#6366f1' },
        modal: {
          ondismiss: () => {
            console.log('[Payment] Razorpay modal dismissed');
            setProcessingPayment(false);
          },
        },
      };

      console.log('[Payment] Opening Razorpay with options:', options);
      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch (err) {
      console.error('[Payment] Error opening checkout:', err);
      notify.error(`Failed to open payment: ${err.message}`);
      setProcessingPayment(false);
    }
  };

  const processPayment = async () => {
    if (!paymentModal) return;
    setProcessingPayment(true);
    console.log('[Payment] Starting payment for invoice:', paymentModal.invoiceNum, 'Gateway:', paymentGateway);

    try {
      if (paymentGateway === 'razorpay') {
        if (!paymentConfig.razorpay?.configured) {
          notify.error('⚠️ Razorpay is not configured. Please add credentials to .env file.');
          setProcessingPayment(false);
          return;
        }

        console.log('[Payment] Creating Razorpay order...');
        const response = await fetchApi('/api/payments/create-razorpay-order', {
          method: 'POST',
          body: JSON.stringify({
            invoiceId: paymentModal.id,
            amount: paymentModal.amount,
            currency: 'INR',
          }),
        });

        console.log('[Payment] Order response:', response);
        if (!response?.orderId) {
          throw new Error('Failed to create payment order: ' + JSON.stringify(response));
        }

        if (!window.Razorpay) {
          console.log('[Payment] Loading Razorpay SDK...');
          const script = document.createElement('script');
          script.src = 'https://checkout.razorpay.com/v1/checkout.js';
          script.async = true;
          script.onload = () => {
            console.log('[Payment] Razorpay SDK loaded');
            openRazorpayCheckout(response, paymentModal);
          };
          script.onerror = () => {
            console.error('[Payment] Failed to load Razorpay SDK');
            notify.error('Failed to load Razorpay SDK');
            setProcessingPayment(false);
          };
          document.body.appendChild(script);
        } else {
          console.log('[Payment] Razorpay SDK already loaded');
          await openRazorpayCheckout(response, paymentModal);
        }
      } else if (paymentGateway === 'stripe') {
        if (!paymentConfig.stripe?.configured) {
          notify.error('⚠️ Stripe is not configured yet. Please add credentials to .env file.');
          setProcessingPayment(false);
          return;
        }

        const response = await fetchApi('/api/payments/create-stripe-intent', {
          method: 'POST',
          body: JSON.stringify({
            invoiceId: paymentModal.id,
            amount: paymentModal.amount,
            currency: 'USD',
          }),
        });

        if (response?.clientSecret) {
          // TODO: Implement Stripe Elements checkout in modal
          notify.error('Stripe checkout coming soon');
          setProcessingPayment(false);
        }
      }
    } catch (err) {
      console.error('[Payment] Error:', err);
      notify.error(`Payment failed: ${err.message}`);
      setProcessingPayment(false);
    }
  };

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '2rem', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Receipt size={26} color="var(--accent-color)" /> Invoices
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Create, track, and manage all invoices across your accounts.
          </p>
        </div>
        {/* #894 — Create Invoice is now a header CTA + drawer (was an inline
            always-visible left-column form). Right-aligned so it sits alongside
            future header controls; primary styling per the c031ba0/50ac575
            Leads pattern. */}
        <button
          type="button"
          className="btn-primary"
          onClick={openCreate}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', fontSize: '0.875rem', whiteSpace: 'nowrap' }}
          aria-label="Create a new invoice"
        >
          <Plus size={16} />
          Create Invoice
        </button>
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

        <div style={{
          marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem',
          padding: '0.25rem 0.75rem', borderRadius: '999px',
          background: 'var(--subtle-bg-4)', border: '1px solid var(--border-color)',
        }}>
          <Filter size={14} color="var(--text-secondary)" />
          <label htmlFor="invoice-status-filter" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
            Status:
          </label>
          <select
            id="invoice-status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="Filter invoices by status"
            className="invoice-status-filter-select"
            style={{
              background: 'transparent', border: 'none', color: 'var(--text-primary)',
              fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', outline: 'none',
              padding: '0.25rem 0.25rem',
            }}
          >
            {/* Options need explicit bg/color — the dropdown popup is rendered
                by the OS/browser and inherits the select's transparent bg,
                making the menu unreadable on the generic CRM dark theme. */}
            <option value="ALL" style={{ background: 'var(--bg-color, #0b0c10)', color: 'var(--text-primary, #fff)' }}>All</option>
            <option value="PAID" style={{ background: 'var(--bg-color, #0b0c10)', color: 'var(--text-primary, #fff)' }}>Paid</option>
            <option value="UNPAID" style={{ background: 'var(--bg-color, #0b0c10)', color: 'var(--text-primary, #fff)' }}>Unpaid</option>
            <option value="OVERDUE" style={{ background: 'var(--bg-color, #0b0c10)', color: 'var(--text-primary, #fff)' }}>Overdue</option>
            <option value="VOIDED" style={{ background: 'var(--bg-color, #0b0c10)', color: 'var(--text-primary, #fff)' }}>Voided</option>
          </select>
        </div>
      </div>

      {/* #894 — Invoice Ledger (full-width; Create Invoice form now lives in
          the drawer below, triggered by the header CTA). */}
      <div>
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
          ) : filteredInvoices.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '4rem 2rem', background: 'var(--subtle-bg-2)', border: '1px dashed var(--border-color)', borderRadius: '8px' }}>
              <Filter size={48} style={{ opacity: 0.2, margin: '0 auto 1rem', color: 'var(--accent-color)' }} />
              <p style={{ color: 'var(--text-secondary)' }}>
                No invoices match the “{STATUS_CONFIG[statusFilter]?.label || statusFilter}” filter.
              </p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              {/* #243: table-layout fixed + per-column widths so the Contact
                  cell can no longer expand past its allotted space and bleed
                  on top of the sticky Actions column. The Contact cell itself
                  also truncates with ellipsis (see <td> below). */}
              <table className="stable-table" style={{ borderCollapse: 'collapse', fontSize: '0.875rem' }} role="table" aria-label="Invoices table">
                <colgroup>
                  <col style={{ width: '120px' }} />
                  <col style={{ width: '110px' }} />
                  <col style={{ width: '100px' }} />
                  <col style={{ width: '120px' }} />
                  <col style={{ width: '110px' }} />
                  <col />
                  <col style={{ width: '260px' }} />
                </colgroup>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Invoice #</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Amount</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Status</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Due Date</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Issued</th>
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Contact</th>
                    {/* #119 polish: sticky right-edge so action buttons are always
                        visible regardless of horizontal scroll position. */}
                    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredInvoices.map(inv => (
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
                      <td style={{ padding: '1rem 0.5rem' }}>
                        {/* #242: removed the hardcoded $ DollarSign icon — formatCurrency()
                            already prefixes the right symbol (₹ for INR tenants, $ for USD,
                            etc.). Stacking the icon caused "$ ₹1,500.00" on Indian tenants. */}
                        <span style={{ color: 'var(--success-color)', fontWeight: 600 }}>{formatCurrency(inv.amount)}</span>
                      </td>
                      <td style={{ padding: '1rem 0.5rem' }}>
                        <StatusBadge status={inv.status} />
                      </td>
                      <td style={{ padding: '1rem 0.5rem', color: 'var(--text-secondary)' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                          <Clock size={13} />
                          {formatDate(inv.dueDate)}
                        </span>
                      </td>
                      <td style={{ padding: '1rem 0.5rem', color: 'var(--text-secondary)' }}>
                        {/* #111: Invoice schema uses issuedDate, not createdAt. */}
                        {inv.issuedDate ? formatDate(inv.issuedDate) : '—'}
                      </td>
                      <td
                        style={{
                          padding: '1rem 0.5rem', color: 'var(--text-secondary)',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}
                        title={inv.contact?.name || 'Unknown'}
                      >
                        {inv.contact?.name || 'Unknown'}
                      </td>
                      <td style={{
                        padding: '1rem 0.5rem', textAlign: 'right',
                      }}>
                        {/* #119 sub-issue: action buttons could overflow the
                            260px Actions column on narrow viewports. flexWrap
                            + minWidth:0 lets them stack instead of bleeding
                            outside the cell. */}
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', flexWrap: 'wrap', minWidth: 0 }}>
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
                            <>
                              <button
                                onClick={() => initiatePayment(inv)}
                                className="btn-secondary"
                                style={{
                                  display: 'flex', alignItems: 'center', gap: '0.3rem',
                                  // #880 — was hardcoded '#3b82f6' (blue); off-token on
                                  // travel-vertical (warm gold + navy palette) AND in
                                  // dark mode globally. var(--accent-color) resolves to
                                  // the active theme's accent in both themes + verticals.
                                  background: 'var(--accent-color)', color: 'var(--accent-text, #fff)', border: 'none',
                                  padding: '0.4rem 0.75rem', fontSize: '0.8rem', borderRadius: '6px',
                                  cursor: 'pointer',
                                }}
                                aria-label={`Pay invoice ${inv.invoiceNum}`}
                              >
                                <CreditCard size={14} /> Pay Now
                              </button>
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
                            </>
                          )}
                          {/* #304: a voided invoice should never offer recurring
                              billing — the user already cancelled it, and
                              activating recurrence on a voided row would silently
                              auto-generate live invoices from a cancelled
                              template. Hide the button entirely for VOIDED. */}
                          {inv.status !== 'VOIDED' && (
                            <button
                              onClick={() => {
                                setRecurInvoice(inv);
                                setRecurFreq(inv.recurFrequency || 'monthly');
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
                          )}
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

      {/* #894 — Create Invoice drawer. Mounted only when `creating` is true.
          Close triggers: X button, ESC keypress (handled by the useEffect
          above), Cancel button, clicking on the dark overlay outside the
          drawer body, and successful submit. Form fields + submit handler
          are unchanged from the previous inline form — only the trigger
          surface moved. */}
      {creating && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) closeCreate(); }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'flex-end',
            zIndex: 1000,
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Create Invoice"
        >
          <div
            style={{
              background: 'var(--surface-color)',
              color: 'var(--text-primary)',
              width: '100%',
              maxWidth: 460,
              height: '100vh',
              overflowY: 'auto',
              padding: '1.5rem',
              boxShadow: '-8px 0 24px rgba(0,0,0,0.2)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Plus size={20} color="var(--accent-color)" /> Create Invoice
              </h3>
              <button
                type="button"
                onClick={closeCreate}
                aria-label="Close"
                style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 4 }}
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={createInvoice} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

              {/* #314: Invoice # is server-generated and was being silently
                  overwritten on save, leaving the user confused about why their
                  custom number didn't stick. Make the field read-only and surface
                  the next number that will be assigned, so what the user sees
                  up-front matches what the backend writes. Custom numbering is an
                  admin-only feature and isn't part of this form. */}
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Invoice #</label>
                <input
                  type="text"
                  className="input-field"
                  placeholder="Auto-generated on save"
                  value={nextInvoiceNum}
                  readOnly
                  aria-label="Invoice number (auto-generated on save)"
                  style={{ opacity: 0.75, cursor: 'not-allowed' }}
                />
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.25rem', display: 'block' }}>
                  Auto-generated on save
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

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button
                  type="button"
                  onClick={closeCreate}
                  style={{ padding: '0.65rem 1.25rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.875rem' }}
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary" style={{ padding: '0.65rem 1.25rem', fontSize: '0.875rem' }}>
                  Issue Invoice
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* #124: Recur modal — replaces the old prompt(). */}
      {recurInvoice && (
        <div
          onClick={() => setRecurInvoice(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="card"
            style={{ background: 'var(--surface-color)', color: 'var(--text-primary)', padding: '1.5rem', borderRadius: '12px', minWidth: '380px', maxWidth: '460px', border: '1px solid var(--border-color)', backdropFilter: 'blur(12px)' }}
          >
            <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.5rem' }}>
              {recurInvoice.isRecurring ? 'Stop recurring billing' : 'Set up recurring billing'}
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1rem' }}>
              Invoice {recurInvoice.invoiceNum} · {formatCurrency(recurInvoice.amount)}
            </p>

            {recurInvoice.isRecurring ? (
              <p style={{ fontSize: '0.85rem', marginBottom: '1.25rem' }}>
                This invoice currently recurs <strong>{recurInvoice.recurFrequency}</strong>. Stopping it will prevent any further auto-generated invoices.
              </p>
            ) : (
              <>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>Frequency</label>
                <select
                  value={recurFreq}
                  onChange={(e) => setRecurFreq(e.target.value)}
                  className="input-field"
                  style={{ width: '100%', padding: '0.55rem', marginBottom: '1rem' }}
                >
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="yearly">Yearly</option>
                </select>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
                  A new invoice will be auto-generated every {recurFreq.replace('ly', '')} starting from this invoice's due date.
                </p>
              </>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button
                onClick={() => setRecurInvoice(null)}
                style={{ padding: '0.5rem 1rem', background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-primary)', borderRadius: '6px', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  const isStopping = recurInvoice.isRecurring;
                  try {
                    await fetchApi(`/api/billing/${recurInvoice.id}/recurring`, {
                      method: 'PUT', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        isRecurring: !isStopping,
                        recurFrequency: isStopping ? null : recurFreq,
                      })
                    });
                    setRecurInvoice(null);
                    loadData();
                  } catch (err) {
                    notify.error(`Failed to ${isStopping ? 'stop' : 'activate'} recurring billing: ${err.message || err}`);
                  }
                }}
                style={{
                  padding: '0.5rem 1rem',
                  background: recurInvoice.isRecurring ? '#ef4444' : 'var(--accent-color)',
                  color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer',
                  fontWeight: 500,
                }}
              >
                {recurInvoice.isRecurring ? 'Stop recurring' : `Activate ${recurFreq}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Payment Modal */}
      {paymentModal && (
        <div
          onClick={() => !processingPayment && setPaymentModal(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="card"
            style={{ background: 'var(--surface-color)', color: 'var(--text-primary)', padding: '2rem', borderRadius: '12px', minWidth: '420px', maxWidth: '500px', border: '1px solid var(--border-color)', backdropFilter: 'blur(12px)' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ fontSize: '1.2rem', fontWeight: 600, margin: 0 }}>
                <CreditCard size={20} style={{ marginRight: '0.5rem', display: 'inline' }} />
                Pay Invoice
              </h3>
              <button
                onClick={() => setPaymentModal(null)}
                disabled={processingPayment}
                aria-label="Close payment dialog"
                title="Close"
                style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: processingPayment ? 'not-allowed' : 'pointer', opacity: processingPayment ? 0.5 : 1 }}
              >
                <X size={20} />
              </button>
            </div>

            <div style={{ background: 'var(--subtle-bg-2)', padding: '1rem', borderRadius: '8px', marginBottom: '1.5rem' }}>
              <p style={{ margin: '0.5rem 0', fontSize: '0.9rem' }}>
                <strong>Invoice:</strong> {paymentModal.invoiceNum}
              </p>
              <p style={{ margin: '0.5rem 0', fontSize: '0.9rem' }}>
                <strong>Amount:</strong> <span style={{ color: 'var(--success-color)', fontWeight: 600 }}>{formatCurrency(paymentModal.amount)}</span>
              </p>
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Payment Method
              </label>
              <div style={{ display: 'flex', gap: '1rem' }}>
                <button
                  onClick={() => !processingPayment && paymentConfig.stripe?.configured && setPaymentGateway('stripe')}
                  disabled={processingPayment || !paymentConfig.stripe?.configured}
                  title={!paymentConfig.stripe?.configured ? 'Stripe credentials not configured' : ''}
                  style={{
                    flex: 1, padding: '0.75rem', borderRadius: '8px',
                    border: `2px solid ${paymentConfig.stripe?.configured ? (paymentGateway === 'stripe' ? 'var(--accent-color)' : 'var(--border-color)') : '#d1d5db'}`,
                    background: paymentGateway === 'stripe' && paymentConfig.stripe?.configured ? 'rgba(99,102,241,0.1)' : !paymentConfig.stripe?.configured ? 'rgba(0,0,0,0.05)' : 'transparent',
                    color: !paymentConfig.stripe?.configured ? '#9ca3af' : (paymentGateway === 'stripe' ? 'var(--accent-color)' : 'var(--text-secondary)'),
                    fontWeight: 600, cursor: (processingPayment || !paymentConfig.stripe?.configured) ? 'not-allowed' : 'pointer',
                    opacity: !paymentConfig.stripe?.configured ? 0.6 : (processingPayment ? 0.5 : 1),
                  }}
                >
                  💳 Stripe {paymentConfig.stripe?.configured ? '✓' : '(Coming)'}
                </button>
                <button
                  onClick={() => !processingPayment && paymentConfig.razorpay?.configured && setPaymentGateway('razorpay')}
                  disabled={processingPayment || !paymentConfig.razorpay?.configured}
                  title={!paymentConfig.razorpay?.configured ? 'Razorpay credentials not configured' : ''}
                  style={{
                    flex: 1, padding: '0.75rem', borderRadius: '8px',
                    border: `2px solid ${paymentConfig.razorpay?.configured ? (paymentGateway === 'razorpay' ? '#1f4788' : 'var(--border-color)') : '#d1d5db'}`,
                    background: paymentGateway === 'razorpay' && paymentConfig.razorpay?.configured ? 'rgba(31,71,136,0.1)' : !paymentConfig.razorpay?.configured ? 'rgba(0,0,0,0.05)' : 'transparent',
                    color: !paymentConfig.razorpay?.configured ? '#9ca3af' : (paymentGateway === 'razorpay' ? '#1f4788' : 'var(--text-secondary)'),
                    fontWeight: 600, cursor: (processingPayment || !paymentConfig.razorpay?.configured) ? 'not-allowed' : 'pointer',
                    opacity: !paymentConfig.razorpay?.configured ? 0.6 : (processingPayment ? 0.5 : 1),
                  }}
                >
                  💰 Razorpay {paymentConfig.razorpay?.configured ? '✓' : '(Setup)'}
                </button>
              </div>
            </div>

            {paymentGateway === 'razorpay' && paymentConfig.razorpay?.configured && (
              <div style={{ background: 'rgba(31,71,136,0.05)', padding: '0.75rem', borderRadius: '8px', marginBottom: '1.5rem', fontSize: '0.8rem', color: '#1f4788', borderLeft: '3px solid #1f4788' }}>
                🧪 <strong>Razorpay Test Card:</strong><br/>
                4386 2894 0766 0153 | Any MM/YY | Any CVV
              </div>
            )}
            {paymentGateway === 'stripe' && paymentConfig.stripe?.configured && (
              <div style={{ background: 'rgba(59,130,246,0.05)', padding: '0.75rem', borderRadius: '8px', marginBottom: '1.5rem', fontSize: '0.8rem', color: 'var(--text-secondary)', borderLeft: '3px solid #3b82f6' }}>
                🧪 <strong>Stripe Test Card:</strong><br/>
                4000 0027 6000 3184 | Any MM/YY | Any CVV (3DS required)
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
              <button
                onClick={() => setPaymentModal(null)}
                disabled={processingPayment}
                style={{
                  padding: '0.65rem 1.5rem', background: 'transparent', border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)', borderRadius: '6px', cursor: processingPayment ? 'not-allowed' : 'pointer',
                  fontWeight: 500, opacity: processingPayment ? 0.5 : 1,
                }}
              >
                Cancel
              </button>
              <button
                onClick={processPayment}
                disabled={processingPayment}
                style={{
                  padding: '0.65rem 1.5rem', background: 'var(--accent-color)', color: '#fff', border: 'none',
                  borderRadius: '6px', cursor: processingPayment ? 'not-allowed' : 'pointer', fontWeight: 600,
                  opacity: processingPayment ? 0.7 : 1, display: 'flex', alignItems: 'center', gap: '0.5rem',
                }}
              >
                {processingPayment ? '⏳ Processing...' : '✓ Pay Now'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
      `}</style>
    </div>
  );
}
