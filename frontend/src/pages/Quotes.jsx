import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Calculator,
  ChevronDown,
  Copy,
  Download,
  FileText,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { fetchApi, getActiveTenantId, getAuthToken } from '../utils/api';
import { formatMoney } from '../utils/money';
import { formatDate } from '../utils/date';
import { useNotify } from '../utils/notify';
import './Quotes.css';

const STATUS_CONFIG = {
  Draft: { color: '#64748b', background: 'rgba(100, 116, 139, 0.12)' },
  Sent: { color: '#2563eb', background: 'rgba(37, 99, 235, 0.12)' },
  Accepted: { color: '#059669', background: 'rgba(5, 150, 105, 0.12)' },
  Rejected: { color: '#dc2626', background: 'rgba(220, 38, 38, 0.12)' },
  Expired: { color: '#b45309', background: 'rgba(180, 83, 9, 0.12)' },
};

const CURRENCIES = ['USD', 'INR', 'EUR', 'GBP', 'AED', 'SGD'];
const EMPTY_ADDRESS = { line1: '', line2: '', city: '', state: '', postalCode: '', country: '' };
const EMPTY_LINE = {
  productName: '',
  description: '',
  quantity: 1,
  cost: 0,
  unitPrice: 0,
  discountPercent: 0,
  gstRate: 0,
};

function dateInputValue(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function todayInputValue() {
  return dateInputValue(new Date());
}

function defaultValidUntil() {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  return dateInputValue(date);
}

function getDefaultCurrency() {
  try {
    return JSON.parse(localStorage.getItem('tenant') || 'null')?.defaultCurrency || 'USD';
  } catch {
    return 'USD';
  }
}

function getDefaultOwner() {
  try {
    const user = JSON.parse(localStorage.getItem('user') || 'null');
    return user?.name || user?.fullName || user?.email || '';
  } catch {
    return '';
  }
}

function emptyForm() {
  return {
    subject: '',
    quoteOwnerName: getDefaultOwner(),
    contactId: '',
    dealId: '',
    accountName: '',
    customerName: '',
    customerEmail: '',
    validUntil: defaultValidUntil(),
    currency: getDefaultCurrency(),
    billingAddress: { ...EMPTY_ADDRESS },
    shippingAddress: { ...EMPTY_ADDRESS },
    adjustment: 0,
    terms: 'Prices are valid until the date shown above. Taxes are calculated on the quoted items.',
    notes: '',
    description: '',
  };
}

function parseAddress(value) {
  if (!value) return { ...EMPTY_ADDRESS };
  if (typeof value === 'object') return { ...EMPTY_ADDRESS, ...value };
  try {
    return { ...EMPTY_ADDRESS, ...JSON.parse(value) };
  } catch {
    return { ...EMPTY_ADDRESS, line1: String(value) };
  }
}

function formFromQuote(quote) {
  return {
    ...emptyForm(),
    subject: quote.title || '',
    quoteOwnerName: quote.quoteOwnerName || '',
    contactId: quote.contactId ? String(quote.contactId) : '',
    dealId: quote.dealId ? String(quote.dealId) : '',
    accountName: quote.accountName || '',
    customerName: quote.customerName || quote.contact?.name || '',
    customerEmail: quote.customerEmail || quote.contact?.email || '',
    validUntil: quote.validUntil ? String(quote.validUntil).slice(0, 10) : defaultValidUntil(),
    currency: CURRENCIES.includes(quote.currency) ? quote.currency : getDefaultCurrency(),
    billingAddress: parseAddress(quote.billingAddress),
    shippingAddress: parseAddress(quote.shippingAddress),
    adjustment: quote.adjustment ?? 0,
    terms: quote.terms || '',
    notes: quote.notes || '',
    description: quote.description || '',
  };
}

function linesFromQuote(quote) {
  if (!Array.isArray(quote.lineItems) || quote.lineItems.length === 0) return [{ ...EMPTY_LINE }];
  return quote.lineItems.map((line) => ({
    productName: line.productName || '',
    description: line.description || '',
    quantity: line.quantity ?? 1,
    cost: line.cost ?? 0,
    unitPrice: line.unitPrice ?? 0,
    discountPercent: line.discountPercent ?? 0,
    gstRate: line.gstRate ?? 0,
  }));
}

function lineMath(line) {
  const quantity = Math.max(0, Number(line.quantity) || 0);
  const unitPrice = Math.max(0, Number(line.unitPrice) || 0);
  const discountPercent = Math.min(100, Math.max(0, Number(line.discountPercent) || 0));
  const gstRate = Math.min(100, Math.max(0, Number(line.gstRate) || 0));
  const amount = quantity * unitPrice;
  const discount = amount * (discountPercent / 100);
  const taxable = amount - discount;
  const gst = taxable * (gstRate / 100);
  return {
    amount,
    discount,
    gst,
    total: taxable + gst,
  };
}

function summarize(lines, adjustment) {
  const summary = lines.reduce((acc, line) => {
    const math = lineMath(line);
    acc.subtotal += math.amount;
    acc.discount += math.discount;
    acc.gst += math.gst;
    acc.total += math.total;
    return acc;
  }, { subtotal: 0, discount: 0, gst: 0, total: 0 });
  summary.adjustment = Number(adjustment) || 0;
  summary.grandTotal = summary.total + summary.adjustment;
  return summary;
}

function Field({ label, required = false, hint, children, className = '' }) {
  return (
    <label className={`quotes-field ${className}`}>
      <span className="quotes-field-label">{label}{required && <span className="quotes-required">*</span>}</span>
      {children}
      {hint && <span className="quotes-field-hint">{hint}</span>}
    </label>
  );
}

function AddressCard({ title, address, onChange, onCopy, copied }) {
  return (
    <section className="quotes-address-card">
      <div className="quotes-section-heading quotes-address-heading">
        <div>
          <span className="quotes-kicker">Customer details</span>
          <h3>{title}</h3>
        </div>
        {onCopy && (
          <button type="button" className="quotes-link-button" onClick={onCopy}>
            <Copy size={14} /> {copied ? 'Copied' : 'Copy billing'}
          </button>
        )}
      </div>
      <div className="quotes-address-grid">
        <Field label="Address line 1" className="quotes-span-2">
          <input autoComplete="off" value={address.line1} onChange={(e) => onChange('line1', e.target.value)} placeholder="Street, building, or house number" />
        </Field>
        <Field label="Address line 2" className="quotes-span-2">
          <input autoComplete="off" value={address.line2} onChange={(e) => onChange('line2', e.target.value)} placeholder="Apartment, suite, or landmark" />
        </Field>
        <Field label="City">
          <input autoComplete="off" value={address.city} onChange={(e) => onChange('city', e.target.value)} placeholder="City" />
        </Field>
        <Field label="State / Province">
          <input autoComplete="off" value={address.state} onChange={(e) => onChange('state', e.target.value)} placeholder="State" />
        </Field>
        <Field label="Postal code">
          <input autoComplete="off" value={address.postalCode} onChange={(e) => onChange('postalCode', e.target.value)} placeholder="Postal code" />
        </Field>
        <Field label="Country">
          <input autoComplete="off" value={address.country} onChange={(e) => onChange('country', e.target.value)} placeholder="Country" />
        </Field>
      </div>
    </section>
  );
}

function LineItemsEditor({ lines, currency, onChange, onAdd, onRemove }) {
  return (
    <section className="quotes-form-section quotes-items-section">
      <div className="quotes-section-heading">
        <div>
          <span className="quotes-kicker">Pricing</span>
          <h3>Quoted items</h3>
        </div>
        <span className="quotes-section-meta">{lines.length} {lines.length === 1 ? 'item' : 'items'}</span>
      </div>
      <div className="quotes-items-table" role="table" aria-label="Quoted items">
        <div className="quotes-items-head" role="row">
          <span>Item</span>
          <span>Description</span>
          <span>Qty</span>
          <span>Cost</span>
          <span>Unit price</span>
          <span>Discount</span>
          <span>GST</span>
          <span>Total</span>
          <span aria-hidden="true" />
        </div>
        {lines.map((line, index) => {
          const math = lineMath(line);
          return (
            <div className="quotes-items-row" role="row" key={`line-${index}`}>
              <div className="quotes-line-item-name">
                <input aria-label={`Item ${index + 1} name`} value={line.productName} onChange={(e) => onChange(index, 'productName', e.target.value)} placeholder="Product or service" />
              </div>
              <div className="quotes-line-description-cell">
                <textarea aria-label={`Item ${index + 1} detail`} value={line.description} onChange={(e) => onChange(index, 'description', e.target.value)} placeholder="What is included?" rows={3} />
              </div>
              <input aria-label={`Item ${index + 1} quantity`} type="number" min="1" step="1" value={line.quantity} onChange={(e) => onChange(index, 'quantity', e.target.value)} />
              <input aria-label={`Item ${index + 1} cost`} type="number" min="0" step="0.01" value={line.cost} onChange={(e) => onChange(index, 'cost', e.target.value)} />
              <input aria-label={`Item ${index + 1} unit price`} type="number" min="0" step="0.01" value={line.unitPrice} onChange={(e) => onChange(index, 'unitPrice', e.target.value)} />
              <div className="quotes-number-with-suffix">
                <input aria-label={`Item ${index + 1} discount`} type="number" min="0" max="100" step="0.5" value={line.discountPercent} onChange={(e) => onChange(index, 'discountPercent', e.target.value)} />
                <span>%</span>
              </div>
              <div className="quotes-number-with-suffix">
                <input aria-label={`Item ${index + 1} GST`} type="number" min="0" max="100" step="0.01" inputMode="decimal" value={line.gstRate} onChange={(e) => onChange(index, 'gstRate', e.target.value)} placeholder="0" />
                <span>%</span>
              </div>
              <strong className="quotes-line-total">{formatMoney(math.total, { currency, minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
              <button type="button" className="quotes-icon-button quotes-danger-button" aria-label={`Remove item ${index + 1}`} onClick={() => onRemove(index)} disabled={lines.length === 1}>
                <Trash2 size={16} />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="quotes-add-row" onClick={onAdd}><Plus size={15} /> Add another item</button>
      <p className="quotes-table-note"><Calculator size={14} /> GST is calculated on the discounted taxable amount. Cost is internal and never included in the customer total.</p>
    </section>
  );
}

function QuoteForm({ contacts, deals, form, lines, saving, editing, onChange, onLineChange, onAddLine, onRemoveLine, onSubmit, onCancel, onCopyBilling }) {
  const [copied, setCopied] = useState(false);
  const summary = summarize(lines, form.adjustment);
  const minValidUntil = todayInputValue();
  const setField = (field, value) => onChange({ ...form, [field]: value });
  const setAddress = (key, field, value) => onChange({ ...form, [key]: { ...form[key], [field]: value } });
  const selectedContact = contacts.find((contact) => String(contact.id) === String(form.contactId));

  const copyBilling = () => {
    onCopyBilling();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="quotes-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="quotes-dialog" role="dialog" aria-modal="true" aria-labelledby="quote-form-title">
        <div className="quotes-dialog-header">
          <div>
            <span className="quotes-kicker">Finance / Quotes</span>
            <h2 id="quote-form-title">{editing ? 'Edit quote' : 'Create a new quote'}</h2>
            <p>{editing ? 'Update the quote details, pricing, or customer information.' : 'Build a polished, tax-ready quote your customer can understand at a glance.'}</p>
          </div>
          <button type="button" className="quotes-icon-button" onClick={onCancel} aria-label="Close quote form"><X size={18} /></button>
        </div>

        <form className="quotes-form" autoComplete="off" onSubmit={onSubmit}>
          <section className="quotes-form-section">
            <div className="quotes-section-heading"><div><span className="quotes-kicker">Step 1</span><h3>Quote information</h3></div><span className="quotes-section-meta">Required fields marked *</span></div>
            <div className="quotes-form-grid">
              <Field label="Subject" required>
                <input autoFocus required value={form.subject} onChange={(e) => setField('subject', e.target.value)} placeholder="e.g. Website redesign proposal" />
              </Field>
              <Field label="Quote owner">
                <input value={form.quoteOwnerName} onChange={(e) => setField('quoteOwnerName', e.target.value)} placeholder="Owner name" />
              </Field>
              <Field label="Customer / contact">
                <select value={form.contactId} onChange={(e) => {
                  const contact = contacts.find((item) => String(item.id) === e.target.value);
                  onChange({ ...form, contactId: e.target.value, customerName: contact?.name || form.customerName, customerEmail: contact?.email || form.customerEmail });
                }}>
                  <option value="">Select a contact</option>
                  {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}{contact.email ? ` · ${contact.email}` : ''}</option>)}
                </select>
              </Field>
              <Field label="Account name">
                <input value={form.accountName} onChange={(e) => setField('accountName', e.target.value)} placeholder="Company or account" />
              </Field>
              <Field label="Deal name">
                <select value={form.dealId} onChange={(e) => setField('dealId', e.target.value)}>
                  <option value="">No deal linked</option>
                  {deals.map((deal) => <option key={deal.id} value={deal.id}>{deal.title}</option>)}
                </select>
              </Field>
              <Field label="Valid until" required>
                <input aria-label="Valid until" required type="date" min={minValidUntil} value={form.validUntil} onInvalid={(e) => e.currentTarget.setCustomValidity(e.currentTarget.value ? 'Valid until must be today or a future date.' : 'Valid until is required.')} onChange={(e) => { e.currentTarget.setCustomValidity(''); setField('validUntil', e.target.value); }} />
              </Field>
              <Field label="Currency">
                <select value={form.currency} onChange={(e) => setField('currency', e.target.value)}>
                  {CURRENCIES.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
                </select>
              </Field>
              <Field label="Customer name">
                <input autoComplete="off" value={form.customerName} onChange={(e) => setField('customerName', e.target.value)} placeholder={selectedContact?.name || 'Customer name'} />
              </Field>
              <Field label="Customer email">
                <input autoComplete="off" type="email" value={form.customerEmail} onChange={(e) => setField('customerEmail', e.target.value)} placeholder={selectedContact?.email || 'name@company.com'} />
              </Field>
            </div>
          </section>

          <section className="quotes-form-section">
            <div className="quotes-section-heading"><div><span className="quotes-kicker">Step 2</span><h3>Address information</h3></div><button type="button" className="quotes-link-button" onClick={copyBilling}><Copy size={14} /> {copied ? 'Copied to shipping' : 'Copy to shipping'}</button></div>
            <div className="quotes-address-layout">
              <AddressCard title="Billing address" address={form.billingAddress} onChange={(field, value) => setAddress('billingAddress', field, value)} />
              <AddressCard title="Shipping address" address={form.shippingAddress} onChange={(field, value) => setAddress('shippingAddress', field, value)} onCopy={copyBilling} copied={copied} />
            </div>
          </section>

          <LineItemsEditor lines={lines} currency={form.currency} onChange={onLineChange} onAdd={onAddLine} onRemove={onRemoveLine} />

          <section className="quotes-bottom-layout">
            <div className="quotes-form-section quotes-notes-section">
              <div className="quotes-section-heading"><div><span className="quotes-kicker">Step 3</span><h3>Customer-facing notes</h3></div></div>
              <Field label="Description" hint="Optional context shown above the item table.">
                <textarea rows={4} value={form.description} onChange={(e) => setField('description', e.target.value)} placeholder="Summarize the proposal or scope of work..." />
              </Field>
              <Field label="Terms and conditions">
                <textarea rows={5} value={form.terms} onChange={(e) => setField('terms', e.target.value)} placeholder="Add payment terms, validity, or delivery notes..." />
              </Field>
              <Field label="Internal notes" hint="Visible to your team only.">
                <textarea rows={3} value={form.notes} onChange={(e) => setField('notes', e.target.value)} placeholder="Add internal context..." />
              </Field>
            </div>
            <aside className="quotes-totals-card">
              <div className="quotes-totals-title"><span>Quote summary</span><span className="quotes-total-currency">{form.currency}</span></div>
              <div className="quotes-total-line"><span>Subtotal</span><strong>{formatMoney(summary.subtotal, { currency: form.currency, minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></div>
              <div className="quotes-total-line"><span>Discount</span><strong className="quotes-total-discount">-{formatMoney(summary.discount, { currency: form.currency, minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></div>
              <div className="quotes-total-line"><span>GST</span><strong>{formatMoney(summary.gst, { currency: form.currency, minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></div>
              <div className="quotes-total-line quotes-adjustment-line"><label htmlFor="quote-adjustment">Adjustment</label><input id="quote-adjustment" type="number" step="0.01" value={form.adjustment} onChange={(e) => setField('adjustment', e.target.value)} /></div>
              <div className="quotes-grand-total"><span>Grand total</span><strong>{formatMoney(summary.grandTotal, { currency: form.currency, minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></div>
              <p className="quotes-total-caption">This is the amount shown to the customer.</p>
            </aside>
          </section>

          <div className="quotes-form-footer">
            <span className="quotes-footer-note"><span className="quotes-footer-dot" /> {editing ? 'Updating quote' : 'Saved as Draft'}</span>
            <div className="quotes-footer-actions"><button type="button" className="quotes-secondary-button" onClick={onCancel}>Cancel</button><button type="submit" className="quotes-primary-button" disabled={saving}>{saving ? (editing ? 'Updating…' : 'Saving…') : (editing ? 'Update quote' : 'Save quote')} <ArrowUpFromLine size={15} /></button></div>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Quotes() {
  const notify = useNotify();
  const [quotes, setQuotes] = useState([]);
  const [stats, setStats] = useState({ total: 0, byStatus: {}, totalValue: 0 });
  const [contacts, setContacts] = useState([]);
  const [deals, setDeals] = useState([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editingQuoteId, setEditingQuoteId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [lines, setLines] = useState([{ ...EMPTY_LINE }]);
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const importRef = useRef(null);

  const loadQuotes = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), limit: '10' });
      if (search.trim()) params.set('search', search.trim());
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const [result, summary] = await Promise.all([
        fetchApi(`/api/quotes?${params.toString()}`),
        fetchApi('/api/quotes/stats'),
      ]);
      setQuotes(Array.isArray(result) ? result : result?.data || []);
      setPagination(result?.pagination || { total: 0, totalPages: 0 });
      setStats(summary || { total: 0, byStatus: {}, totalValue: 0 });
    } catch (err) {
      setError(err?.message || 'Unable to load quotes.');
    } finally {
      setLoading(false);
    }
  }, [page, search, statusFilter]);

  useEffect(() => { loadQuotes(); }, [loadQuotes, reload]);

  useEffect(() => {
    Promise.all([
      fetchApi('/api/contacts?limit=200', { silent: true }),
      fetchApi('/api/deals?limit=200', { silent: true }),
    ]).then(([contactResult, dealResult]) => {
      setContacts(Array.isArray(contactResult) ? contactResult : contactResult?.data || []);
      setDeals(Array.isArray(dealResult) ? dealResult : dealResult?.data || []);
    }).catch(() => {
      // The form still works with manual customer and product entry when the
      // optional lookup endpoints are unavailable.
    });
  }, []);


  const openCreate = () => {
    const dealId = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('dealId') || ''
      : '';
    setForm({ ...emptyForm(), dealId });
    setLines([{ ...EMPTY_LINE }]);
    setEditingQuoteId(null);
    setCreateOpen(true);
  };

  const openEdit = async (quote) => {
    try {
      const detail = await fetchApi(`/api/quotes/${quote.id}`);
      const source = detail?.id ? detail : quote;
      setForm(formFromQuote(source));
      setLines(linesFromQuote(source));
      setEditingQuoteId(quote.id);
      setCreateOpen(true);
    } catch {
      notify.error('Unable to load quote details for editing.');
    }
  };

  const closeForm = () => {
    setCreateOpen(false);
    setEditingQuoteId(null);
  };

  const submitQuote = async (event) => {
    event.preventDefault();
    if (!lines.some((line) => line.productName.trim() || line.description.trim())) {
      notify.error('Add at least one product or service before saving.');
      return;
    }
    setSaving(true);
    const editing = Boolean(editingQuoteId);
    try {
      await fetchApi(editing ? `/api/quotes/${editingQuoteId}` : '/api/quotes', {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify({ ...form, contactId: form.contactId || null, dealId: form.dealId || null, lineItems: lines }),
      });
      notify.success(editing ? 'Quote updated.' : 'Quote saved as draft.');
      closeForm();
      setReload((value) => value + 1);
    } catch {
      notify.error('Unable to save quote. Please review the form and try again.');
    } finally {
      setSaving(false);
    }
  };

  const updateLine = (index, field, value) => setLines((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, [field]: value } : line));
  const addLine = () => setLines((current) => [...current, { ...EMPTY_LINE }]);
  const removeLine = (index) => setLines((current) => current.length === 1 ? current : current.filter((_, lineIndex) => lineIndex !== index));
  const copyBilling = () => setForm((current) => ({ ...current, shippingAddress: { ...current.billingAddress } }));

  const updateStatus = async (quote, status) => {
    try {
      await fetchApi(`/api/quotes/${quote.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      notify.success(`Quote marked ${status.toLowerCase()}.`);
      setReload((value) => value + 1);
    } catch {
      notify.error('Unable to update quote status.');
    }
  };

  const deleteQuote = async (quote) => {
    if (!await notify.confirm({ title: 'Delete quote', message: `Delete ${quote.quoteNumber || quote.title}? This cannot be undone.`, confirmText: 'Delete', destructive: true })) return;
    try {
      await fetchApi(`/api/quotes/${quote.id}`, { method: 'DELETE' });
      notify.success('Quote deleted.');
      setReload((value) => value + 1);
    } catch {
      notify.error('Unable to delete quote.');
    }
  };

  const downloadFile = async (endpoint, filename) => {
    try {
      const token = getAuthToken();
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const activeTenantId = getActiveTenantId();
      if (activeTenantId != null) headers['X-Active-Tenant'] = String(activeTenantId);
      const response = await fetch(endpoint, { credentials: 'include', headers });
      if (!response.ok) throw new Error('Download failed');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      notify.error('Unable to download the file.');
    }
  };

  const exportQuotes = (format) => {
    setExportOpen(false);
    downloadFile(`/api/quotes/export.${format}`, `quotes.${format}`);
  };

  const downloadQuotePdf = async (quote) => {
    try {
      const token = getAuthToken();
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const activeTenantId = getActiveTenantId();
      if (activeTenantId != null) headers['X-Active-Tenant'] = String(activeTenantId);
      const response = await fetch(`/api/quotes/${quote.id}/pdf`, { credentials: 'include', headers });
      if (!response.ok) throw new Error('Download failed');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${quote.quoteNumber || `quote-${quote.id}`}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      notify.error('Unable to download the quote PDF.');
    }
  };

  const openImport = () => {
    setImportFile(null);
    setImportOpen(true);
  };

  const closeImport = () => {
    if (importing) return;
    setImportOpen(false);
    setImportFile(null);
  };

  const selectImportFile = (event) => {
    setImportFile(event.target.files?.[0] || null);
    event.target.value = '';
  };

  const importCsv = async () => {
    if (!importFile) return;
    setImporting(true);
    try {
      const data = new FormData();
      data.append('file', importFile);
      const token = getAuthToken();
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const activeTenantId = getActiveTenantId();
      if (activeTenantId != null) headers['X-Active-Tenant'] = String(activeTenantId);
      const format = importFile.name.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv';
      const response = await fetch(`/api/quotes/import.${format}`, { method: 'POST', body: data, credentials: 'include', headers });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error || 'Import failed');
      notify.success(`${result.imported || 0} quote${result.imported === 1 ? '' : 's'} imported${result.errors?.length ? ` · ${result.errors.length} row${result.errors.length === 1 ? '' : 's'} skipped` : ''}.`);
      setImportOpen(false);
      setImportFile(null);
      setReload((value) => value + 1);
    } catch (err) {
      notify.error(err?.message || 'Unable to import the spreadsheet.');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="quotes-page">
      <header className="quotes-page-header">
        <div className="quotes-heading-copy">
          <div className="quotes-title-row"><span className="quotes-title-icon"><FileText size={20} /></span><h1>Quotes</h1></div>
          <p>Create, organize, and track professional customer quotes from one workspace.</p>
        </div>
        <div className="quotes-header-actions">
          <div className="quotes-import-menu">
            <button type="button" className="quotes-secondary-button" onClick={openImport}><Upload size={15} /> Import <ChevronDown size={14} /></button>
          </div>
          <div className="quotes-export-menu">
            <button type="button" className="quotes-secondary-button" onClick={() => setExportOpen((value) => !value)} aria-expanded={exportOpen}><ArrowDownToLine size={15} /> Export <ChevronDown size={14} /></button>
            {exportOpen && <div className="quotes-export-options" role="menu"><button type="button" role="menuitem" onClick={() => exportQuotes('csv')}><Download size={14} /> Export CSV</button><button type="button" role="menuitem" onClick={() => exportQuotes('xlsx')}><Download size={14} /> Export XLSX</button></div>}
          </div>
          <button type="button" className="quotes-primary-button" onClick={openCreate}><Plus size={16} /> Create quote</button>
        </div>
      </header>

      <section className="quotes-stat-grid" aria-label="Quote summary">
        <div className="quotes-stat-card"><span className="quotes-stat-label">Total quotes</span><strong>{stats.total ?? 0}</strong><span className="quotes-stat-foot"><FileText size={13} /> All records</span></div>
        <div className="quotes-stat-card"><span className="quotes-stat-label">Drafts</span><strong>{stats.byStatus?.Draft || 0}</strong><span className="quotes-stat-foot quotes-stat-muted">Work in progress</span></div>
        <div className="quotes-stat-card"><span className="quotes-stat-label">Awaiting response</span><strong>{(stats.byStatus?.Sent || 0) + (stats.byStatus?.Draft || 0)}</strong><span className="quotes-stat-foot quotes-stat-blue">Draft + sent</span></div>
        <div className="quotes-stat-card quotes-stat-card-accent"><span className="quotes-stat-label">Quote value</span><strong>{stats.totalValue == null ? '—' : formatMoney(stats.totalValue, { currency: stats.currency || getDefaultCurrency(), minimumFractionDigits: 0, maximumFractionDigits: 0 })}</strong><span className="quotes-stat-foot quotes-stat-purple">{stats.missingRateCount ? 'Exchange rates unavailable' : 'Across all quotes'}</span></div>
      </section>

      <section className="quotes-list-card">
        <div className="quotes-list-toolbar">
          <div><h2>All quotes</h2><p>{pagination.total || quotes.length} customer records</p></div>
          <div className="quotes-list-controls">
            <label className="quotes-search"><Search size={16} /><input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search quotes..." aria-label="Search quotes" /></label>
            <select className="quotes-filter-select" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} aria-label="Filter quotes by status">
              <option value="all">All statuses</option>
              {Object.keys(STATUS_CONFIG).map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
            <button type="button" className="quotes-icon-button" onClick={() => setReload((value) => value + 1)} aria-label="Refresh quotes"><RefreshCw size={16} /></button>
          </div>
        </div>

        {error && <div className="quotes-alert" role="alert">{error}</div>}
        {loading ? (
          <div className="quotes-empty-state"><RefreshCw size={28} className="quotes-spin" /><h3>Loading quotes</h3><p>Getting the latest records from your workspace.</p></div>
        ) : quotes.length === 0 ? (
          <div className="quotes-empty-state"><span className="quotes-empty-icon"><FileText size={28} /></span><h3>No quotes yet</h3><p>Create your first quote or import your existing quote register from a CSV template.</p><button type="button" className="quotes-primary-button" onClick={openCreate}><Plus size={15} /> Create your first quote</button></div>
        ) : (
          <div className="quotes-table-scroll">
            <table className="quotes-table"><thead><tr><th className="quotes-table-heading-quote"><span className="quotes-table-quote-heading-label">Quote</span></th><th>Customer</th><th>Deal</th><th>Valid until</th><th className="quotes-table-heading-number">Items</th><th className="quotes-table-heading-total">Total</th><th className="quotes-table-heading-status">Status</th><th className="quotes-table-heading-actions">Actions</th></tr></thead>
              <tbody>{quotes.map((quote) => <tr key={quote.id}>
                <td className="quotes-table-quote"><div className="quotes-primary-cell quotes-primary-cell-quote"><strong>{quote.quoteNumber || `#${quote.id}`}</strong><span>{quote.title}</span></div></td>
                <td><div className="quotes-primary-cell"><strong>{quote.customerName || quote.contact?.name || 'No customer'}</strong><span>{quote.customerEmail || quote.contact?.email || quote.accountName || '—'}</span></div></td>
                <td><span className="quotes-table-cell-text" title={quote.deal?.title || undefined}>{quote.deal?.title || '—'}</span></td>
                <td><span className="quotes-table-cell-text">{quote.validUntil ? formatDate(quote.validUntil) : '—'}</span></td>
                <td className="quotes-table-number"><span className="quotes-table-cell-text">{quote.lineItems?.length || 0}</span></td>
                <td className="quotes-table-total"><strong className="quotes-table-cell-text">{formatMoney(quote.totalAmount, { currency: quote.currency || getDefaultCurrency(), minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></td>
                <td className="quotes-table-status"><select className="quotes-status-select" aria-label={`Change status for ${quote.quoteNumber || quote.title}`} value={quote.status || 'Draft'} onChange={(e) => updateStatus(quote, e.target.value)}><option value="Draft">Draft</option><option value="Sent">Sent</option><option value="Accepted">Accepted</option><option value="Rejected">Rejected</option><option value="Expired">Expired</option></select></td>
                <td><div className="quotes-row-actions"><button type="button" className="quotes-icon-button" aria-label={`Edit ${quote.quoteNumber || quote.title}`} onClick={() => openEdit(quote)}><Pencil size={15} /></button><button type="button" className="quotes-icon-button" aria-label={`Download PDF for ${quote.quoteNumber || quote.title}`} onClick={() => downloadQuotePdf(quote)}><Download size={15} /></button><button type="button" className="quotes-icon-button quotes-danger-button" aria-label={`Delete ${quote.quoteNumber || quote.title}`} onClick={() => deleteQuote(quote)}><Trash2 size={15} /></button></div></td>
              </tr>)}</tbody>
            </table>
          </div>
        )}
        {!loading && quotes.length > 0 && <div className="quotes-list-footer"><span>Showing {quotes.length} of {pagination.total || quotes.length}</span><div className="quotes-pagination"><button type="button" className="quotes-page-button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button><span>Page {page}{pagination.totalPages ? ` of ${pagination.totalPages}` : ''}</span><button type="button" className="quotes-page-button" disabled={!pagination.totalPages || page >= pagination.totalPages} onClick={() => setPage((value) => value + 1)}>Next</button></div></div>}
      </section>

      {createOpen && <QuoteForm contacts={contacts} deals={deals} form={form} lines={lines} saving={saving} editing={Boolean(editingQuoteId)} onChange={setForm} onLineChange={updateLine} onAddLine={addLine} onRemoveLine={removeLine} onSubmit={submitQuote} onCancel={closeForm} onCopyBilling={copyBilling} />}
      {importOpen && (
        <div className="quotes-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeImport(); }}>
          <div className="quotes-import-dialog" role="dialog" aria-modal="true" aria-labelledby="quote-import-title">
            <div className="quotes-import-dialog-header">
              <div>
                <span className="quotes-kicker">Quotes / Import</span>
                <h2 id="quote-import-title">Import quotes</h2>
                <p>Use the template to prepare your quote register, then upload it here.</p>
              </div>
              <button type="button" className="quotes-icon-button" onClick={closeImport} aria-label="Close import dialog"><X size={18} /></button>
            </div>
            <div className="quotes-import-dialog-body">
              <div className="quotes-import-step">
                <span className="quotes-import-step-number">1</span>
                <div><h3>Download a template</h3><p>Choose CSV or XLSX with the supported columns and example values.</p></div>
                <div className="quotes-import-format-actions"><button type="button" className="quotes-secondary-button" onClick={() => downloadFile('/api/quotes/template.csv', 'quotes-template.csv')}><Download size={15} /> CSV</button><button type="button" className="quotes-secondary-button" onClick={() => downloadFile('/api/quotes/template.xlsx', 'quotes-template.xlsx')}><Download size={15} /> XLSX</button></div>
              </div>
              <div className="quotes-import-step">
                <span className="quotes-import-step-number">2</span>
                <div><h3>Upload your completed file</h3><p>Import one CSV or XLSX file containing your quote rows.</p></div>
                <button type="button" className="quotes-secondary-button" onClick={() => importRef.current?.click()}><Upload size={15} /> Choose file</button>
                <input ref={importRef} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={selectImportFile} hidden />
                {importFile && <span className="quotes-import-file">{importFile.name}</span>}
              </div>
            </div>
            <div className="quotes-import-dialog-footer">
              <button type="button" className="quotes-secondary-button" onClick={closeImport} disabled={importing}>Cancel</button>
              <button type="button" className="quotes-primary-button" onClick={importCsv} disabled={!importFile || importing}>{importing ? 'Importing…' : 'Import quotes'} <Upload size={15} /></button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
