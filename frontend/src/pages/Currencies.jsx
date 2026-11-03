import React, { useState, useEffect, useContext, useRef } from 'react';
import { DollarSign, Plus, Edit, Star, Trash2, RefreshCw, X, TrendingUp, Search, LineChart } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { formatCurrency } from '../utils/currency';
import TopScrollSync from '../components/TopScrollSync';
import { AuthContext } from '../appContexts';

export default function Currencies() {
  const notify = useNotify();
  const { tenant, setTenant } = useContext(AuthContext);
  const [currencies, setCurrencies] = useState([]);
  const [pivot, setPivot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [showRates, setShowRates] = useState(false);
  const [rateBaseCode, setRateBaseCode] = useState('');
  const [rateSearch, setRateSearch] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editRate, setEditRate] = useState('');
  const [form, setForm] = useState({ code: '', symbol: '', name: '', exchangeRate: '', isBase: false });
  const [catalog, setCatalog] = useState(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [manualEntry, setManualEntry] = useState(false);
  const [error, setError] = useState('');
  const [savingReportingCurrency, setSavingReportingCurrency] = useState(false);
  const seedPromiseRef = useRef(null);

  // #473: the prior heuristic — `currencies[0].id > 0` — assumed the backend
  // ordering put a persisted row first. The /api/currencies route sorts by
  // `[isBase desc, code asc]`, and the preview shape uses negative ids. In
  // practice that's been correct, but reporters saw BOTH the "not initialized"
  // banner AND a fully populated table at the same time. The likely cause is
  // a transient race where one row in the cached state still had a negative id
  // while the rest were persisted. Make the check robust by requiring EVERY
  // row to be persisted (positive id) before hiding the banner — that way a
  // mixed state errs on the side of "show the banner" rather than the
  // contradictory "show banner over real data."
  const isPersisted = currencies.length > 0 && currencies.every((c) => c.id > 0);

  const confirmCurrencyChange = (currency) => notify.confirm({
    title: `Change base currency to ${currency.code}?`,
    message: `This will make ${currency.code} (${currency.name}) the base and reporting currency.\n\n• All exchange rates will be recalculated relative to 1 ${currency.code}.\n• Revenue, pipeline, and other reporting totals will display in ${currency.code}.\n• Existing deals, invoices, and payments will keep their original currency and amount.\n\nDo you want to continue?`,
    confirmText: `Change to ${currency.code}`,
    cancelText: 'Keep current currency',
  });

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      let [c, p] = await Promise.all([
        fetchApi('/api/currencies'),
        fetchApi('/api/currencies/pivot/deals').catch(() => null),
      ]);

      // Persist preview defaults automatically. The shared promise prevents
      // React StrictMode's duplicate mount effect from sending two seed calls.
      if (Array.isArray(c) && c.some((currency) => currency.id <= 0)) {
        if (!seedPromiseRef.current) {
          seedPromiseRef.current = fetchApi('/api/currencies/seed', { method: 'POST' })
            .catch((error) => {
              seedPromiseRef.current = null;
              throw error;
            });
        }
        c = await seedPromiseRef.current;
        const seededBase = c.find((currency) => currency.isBase);
        if (seededBase && typeof setTenant === 'function') {
          setTenant({ ...(tenant || {}), defaultCurrency: seededBase.code });
        }
        // The first pivot used preview data; refresh after initialization.
        p = await fetchApi('/api/currencies/pivot/deals').catch(() => null);
      }
      setCurrencies(c || []);
      setPivot(p);
    } catch (e) {
      setError(e.message || 'Failed to load currencies');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleAdd = async () => {
    if (!form.code || !form.symbol || !form.name) return notify.error('Code, symbol, and name are required');
    const rate = Number(form.exchangeRate);
    if (!Number.isFinite(rate) || rate <= 0) return notify.error('Enter an exchange rate greater than zero');
    if (form.isBase && !await confirmCurrencyChange(form)) return;
    try {
      const created = await fetchApi('/api/currencies', {
        method: 'POST',
        body: JSON.stringify({ ...form, exchangeRate: rate }),
      });
      if (form.isBase && typeof setTenant === 'function') {
        setTenant({ ...(tenant || {}), defaultCurrency: created.code || form.code.toUpperCase() });
      }
      setShowAdd(false);
      setForm({ code: '', symbol: '', name: '', exchangeRate: '', isBase: false });
      await load();
    } catch (e) { notify.error(e.message || 'Failed to create currency'); }
  };

  const handleSetBase = async (id) => {
    const selected = currencies.find((currency) => currency.id === id);
    if (!selected || selected.code === baseCode) return;
    if (!await confirmCurrencyChange(selected)) return;
    try {
      await fetchApi(`/api/currencies/${id}/set-base`, { method: 'POST' });
      if (selected?.code && typeof setTenant === 'function') {
        setTenant({ ...(tenant || {}), defaultCurrency: selected.code });
      }
      await load();
      notify.success(`${selected?.code || 'Currency'} is now the reporting currency`);
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
    const rate = Number(editRate);
    if (!Number.isFinite(rate) || rate <= 0) return notify.error('Enter an exchange rate greater than zero');
    try {
      await fetchApi(`/api/currencies/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ exchangeRate: rate }),
      });
      setEditingId(null);
      load();
    } catch (e) { notify.error(e.message || 'Failed to update rate'); }
  };

  // #719 — single source of truth for "which currency is base" used by BOTH
  // the header tile AND each table row's BASE radio. Pre-fix the radio
  // checked-state read `!!c.isBase` directly, which in preview mode could
  // visually disagree with the header (the header used a `find || [0]`
  // fallback so it always had a value; the radios used the raw boolean and
  // — combined with `disabled={!persisted}` rendering the dot greyed-out —
  // looked like "no row selected" to the reporter). Deriving both surfaces
  // from `baseCode` guarantees they show the same currency, and switching
  // the row check to `c.code === baseCode` keeps the visual selection
  // accurate even when the underlying row's `isBase` flag is missing or
  // false on the seed-defaults.
  const baseCurrency = currencies.find((c) => c.isBase) || currencies[0];
  const baseCode = baseCurrency?.code;
  const reportingCurrency = tenant?.defaultCurrency || baseCode || 'USD';
  const reportingRate = Number(currencies.find((currency) => currency.code === reportingCurrency)?.exchangeRate || 1);
  const displayRate = (currency) => {
    const rate = Number(currency.exchangeRate);
    if (!Number.isFinite(rate) || !Number.isFinite(reportingRate) || reportingRate <= 0) return null;
    return rate / reportingRate;
  };

  useEffect(() => {
    if (!showAdd && !showRates) return undefined;
    let active = true;
    if (showAdd) {
      setForm({ code: '', symbol: '', name: '', exchangeRate: '', isBase: false });
      setManualEntry(false);
    }
    setCatalog(null);
    setCatalogError('');
    setCatalogLoading(true);
    const loadExternalCatalog = async () => {
      const baseCode = tenant?.defaultCurrency || 'USD';
      const [detailsResponse, ratesResponse] = await Promise.all([
        fetch('https://api.frankfurter.dev/v2/currencies'),
        fetch(`https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(baseCode)}`),
      ]);
      if (!detailsResponse.ok || !ratesResponse.ok) throw new Error('Currency catalog unavailable');
      const [details, latest] = await Promise.all([detailsResponse.json(), ratesResponse.json()]);
      const currencies = (Array.isArray(details) ? details : [])
        .map((currency) => ({
          code: currency.iso_code,
          symbol: currency.symbol,
          name: currency.name,
          exchangeRate: Number(latest?.rates?.[currency.iso_code]),
        }))
        .filter((currency) => /^[A-Z]{3}$/.test(currency.code)
          && currency.name && currency.symbol
          && Number.isFinite(currency.exchangeRate) && currency.exchangeRate > 0)
        .sort((a, b) => a.name.localeCompare(b.name));
      return { baseCode, asOf: latest?.date || null, currencies };
    };
    fetchApi('/api/currencies/catalog', { silent: true })
      .catch(() => loadExternalCatalog())
      .then((result) => {
        if (active) {
          setCatalog(result);
          setRateBaseCode(result?.baseCode || '');
        }
      })
      .catch(() => {
        if (active) {
          setCatalogError('Currency lookup is unavailable. Enter the details manually.');
          if (showAdd) setManualEntry(true);
        }
      })
      .finally(() => { if (active) setCatalogLoading(false); });
    return () => { active = false; };
  }, [showAdd, showRates, tenant?.defaultCurrency]);

  const availableCurrencies = (catalog?.currencies || []).filter(
    (currency) => !currencies.some((existing) => existing.code === currency.code),
  );
  const selectedRateBase = (catalog?.currencies || []).find((currency) => currency.code === rateBaseCode);
  const selectedRateBaseValue = Number(selectedRateBase?.exchangeRate || 1);
  const normalizedRateSearch = rateSearch.trim().toLowerCase();
  const visibleCatalogCurrencies = (catalog?.currencies || [])
    .filter((currency) => (
      !normalizedRateSearch
      || currency.code.toLowerCase().includes(normalizedRateSearch)
      || currency.name.toLowerCase().includes(normalizedRateSearch)
    ))
    .map((currency) => ({
      ...currency,
      displayRate: Number(currency.exchangeRate) / selectedRateBaseValue,
    }));

  const handleCurrencySelection = (event) => {
    const code = event.target.value;
    if (code === 'manual') {
      setManualEntry(true);
      setForm({ code: '', symbol: '', name: '', exchangeRate: '', isBase: false });
      return;
    }
    const selected = availableCurrencies.find((currency) => currency.code === code);
    setManualEntry(false);
    setForm({
      code: selected?.code || '',
      symbol: selected?.symbol || '',
      name: selected?.name || '',
      exchangeRate: selected ? String(selected.exchangeRate) : '',
      isBase: false,
    });
  };

  const handleReportingCurrencyChange = async (event) => {
    const defaultCurrency = event.target.value;
    if (!defaultCurrency || defaultCurrency === reportingCurrency || savingReportingCurrency) return;
    const selected = currencies.find((currency) => currency.code === defaultCurrency);
    if (!selected?.id || selected.id <= 0) return;
    setSavingReportingCurrency(true);
    try {
      if (!await confirmCurrencyChange(selected)) return;
      await fetchApi(`/api/currencies/${selected.id}/set-base`, { method: 'POST' });
      if (typeof setTenant === 'function') {
        setTenant({ ...(tenant || {}), defaultCurrency });
      }
      await load();
      notify.success(`Reporting currency set to ${defaultCurrency}`);
    } catch (e) {
      notify.error(e.message || 'Failed to update reporting currency');
    } finally {
      setSavingReportingCurrency(false);
    }
  };

  return (
    <div className="currencies-page" style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      <header style={{ marginBottom: '2rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <DollarSign size={24} style={{ color: 'var(--accent-color)' }} />
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Currencies</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Manage currencies, FX rates, and per-deal currency conversion</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            className="btn-secondary"
            onClick={() => { setRateBaseCode(''); setRateSearch(''); setShowRates(true); }}
            style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1rem', fontSize: '0.85rem' }}
          >
            <LineChart size={14} /> Check Currency Rates
          </button>
          <button className="btn-secondary" onClick={load} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1rem', fontSize: '0.85rem' }}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button className="btn-primary" onClick={() => setShowAdd(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1rem', fontSize: '0.85rem' }}>
            <Plus size={15} /> Add Currency
          </button>
        </div>
      </header>

      {/* Stats */}
      {/* #473: when in preview mode (banner showing), labelling the stat as
          "Active Currencies: 6" looks like a contradiction with the
          "not initialized" banner above it. Append "(preview)" so the two
          statements agree — they're showing the default set, not persisted
          tenant data. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
        <StatCard
          icon={<DollarSign size={18} />}
          label={isPersisted ? 'Active Currencies' : 'Available Currencies (preview)'}
          value={currencies.length}
          accent="#10b981"
        />
        <StatCard
          icon={<Star size={18} />}
          label={isPersisted ? 'Base Currency' : 'Default Base (preview)'}
          value={baseCurrency ? `${baseCurrency.code} (${baseCurrency.symbol})` : '—'}
          accent="#f59e0b"
        />
        <StatCard
          icon={<TrendingUp size={18} />}
          label={`Open Pipeline (in ${pivot?.reportingCode || reportingCurrency})`}
          value={pivot ? formatCurrency(pivot.totalInReporting, pivot.reportingCode || reportingCurrency) : '—'}
          subtitle={pivot ? `${pivot.dealCount} open deals` : ''}
          accent="#6366f1"
        />
      </div>

      <section className="card" style={{ padding: '1.25rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 600 }}>Reporting currency</div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Used for revenue and pipeline totals across the CRM. Deal amounts keep their original currencies.</div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', fontSize: '0.9rem' }}>
          <span>Currency</span>
          <select
            aria-label="Reporting currency"
            className="input-field"
            value={reportingCurrency}
            disabled={savingReportingCurrency || currencies.length === 0}
            onChange={handleReportingCurrencyChange}
            style={{ minWidth: 140, padding: '0.5rem 0.75rem' }}
          >
            {!currencies.some((currency) => currency.code === reportingCurrency) && <option value={reportingCurrency}>{reportingCurrency}</option>}
            {currencies.map((currency) => <option key={currency.code} value={currency.code}>{currency.code} ({currency.symbol})</option>)}
          </select>
        </label>
      </section>

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
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Total in {pivot.reportingCode || reportingCurrency}</span>
            <span style={{ fontWeight: 700, fontSize: '1.125rem', color: 'var(--accent-color)' }}>{formatCurrency(pivot.totalInReporting, pivot.reportingCode || reportingCurrency)}</span>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="card" style={{ padding: 0, overflow: 'visible' }}>
        {loading ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading currencies...</div>
        ) : (
          <TopScrollSync>
          <table className="stable-table currencies-table" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--subtle-bg)', textAlign: 'left' }}>
                <th style={th}>Code</th>
                <th style={th}>Symbol</th>
                <th style={th}>Name</th>
                <th style={th}>Exchange Rate (1 {reportingCurrency})</th>
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
                        <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', flexWrap: 'wrap' }}>
                          <label htmlFor={`currency-rate-${c.id}`} style={{ width: '100%', fontSize: '0.75rem' }}>
                            Stored rate: 1 {baseCode} = X {c.code} (table displays per {reportingCurrency})
                          </label>
                          <input
                            id={`currency-rate-${c.id}`}
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
                        <div style={{ fontFamily: 'monospace' }}>
                          <div>{displayRate(c) == null ? '—' : displayRate(c).toFixed(4)}</div>
                          <div style={{ fontFamily: 'inherit', fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                            1 {reportingCurrency} = {displayRate(c) == null ? '—' : displayRate(c).toFixed(4)} {c.code}
                          </div>
                        </div>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: 'center' }}>
                      {/* #719 — radio reads from the same `baseCode` the
                          header tile uses; this guarantees the two surfaces
                          can never disagree about which currency is base.
                          We use `readOnly` (not `disabled`) when the rows
                          are unpersisted preview defaults — disabled radios
                          render with a greyed-out dot that reporters
                          perceived as "no selection". readOnly keeps the
                          fill visible while still blocking the click. */}
                      <input
                        type="radio"
                        name="baseCurrency"
                        checked={c.code === baseCode}
                        readOnly={!persisted}
                        onChange={() => persisted && handleSetBase(c.id)}
                        title={persisted ? 'Set as base' : 'Initialize defaults first to change base'}
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
                        {persisted && !c.isBase && (
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
          </TopScrollSync>
        )}
      </div>

      {/* Published currency-rate catalog */}
      {showRates && (
        <div className="currency-rates-overlay">
          <div
            className="card currency-rates-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="currency-rates-title"
          >
            <div className="currency-rates-header">
              <div style={{ minWidth: 0 }}>
                <h3 id="currency-rates-title" style={{ fontWeight: 700, marginBottom: '0.25rem' }}>Currency Exchange Rates</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
                  {catalog
                    ? `Published rates for 1 ${rateBaseCode || catalog.baseCode}${catalog.asOf ? `, as of ${catalog.asOf}` : ''}.`
                    : 'Loading the latest published exchange rates.'}
                </p>
              </div>
              <button className="currency-rates-close" onClick={() => setShowRates(false)} aria-label="Close currency rates dialog" title="Close"><X size={18} /></button>
            </div>

            {!catalogLoading && catalog && (
              <div className="currency-rates-control-group">
                <div className="currency-rates-controls-label">Reference currency</div>
                <div className="currency-rates-controls">
                  <div className="currency-rates-search">
                    <Search size={16} aria-hidden="true" />
                    <input
                      className="input-field currency-rates-search-input"
                      aria-label="Search currency rates"
                      placeholder="Search by currency name or code"
                      value={rateSearch}
                      onChange={(event) => setRateSearch(event.target.value)}
                    />
                  </div>
                  <select
                    className="input-field currency-rates-select"
                    aria-label="Rate reference currency"
                    value={rateBaseCode || catalog.baseCode}
                    onChange={(event) => setRateBaseCode(event.target.value)}
                  >
                    {catalog.currencies.map((currency) => (
                      <option key={currency.code} value={currency.code}>{currency.code} — {currency.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <div className="currency-rates-table-scroll" style={{ minHeight: 180 }}>
              {catalogLoading && <div style={{ padding: '3rem 1rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading currency rates...</div>}
              {!catalogLoading && catalogError && (
                <div role="alert" style={{ padding: '2rem 1rem', textAlign: 'center' }}>
                  <p style={{ color: '#ef4444', marginBottom: '1rem' }}>Currency rates are temporarily unavailable.</p>
                  <button className="btn-secondary" onClick={() => { setShowRates(false); setTimeout(() => setShowRates(true), 0); }}>Try Again</button>
                </div>
              )}
              {!catalogLoading && catalog && (
                <table className="stable-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <thead>
                    <tr style={{ background: 'var(--subtle-bg)', textAlign: 'left' }}>
                      <th style={th}>Code</th>
                      <th style={th}>Symbol</th>
                      <th style={th}>Currency</th>
                      <th style={{ ...th, textAlign: 'right' }}>Rate (1 {rateBaseCode || catalog.baseCode})</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleCatalogCurrencies.map((currency) => (
                      <tr key={currency.code} style={{ borderTop: '1px solid var(--border-color)' }}>
                        <td style={td}><strong>{currency.code}</strong></td>
                        <td style={td}>{currency.symbol}</td>
                        <td style={td}>{currency.name}</td>
                        <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{currency.displayRate.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                      </tr>
                    ))}
                    {visibleCatalogCurrencies.length === 0 && (
                      <tr><td colSpan={4} style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No currencies match your search.</td></tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Add Modal */}
      {showAdd && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay-bg, rgba(0,0,0,0.6))', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
          <div className="card" style={{ padding: '2rem', width: 460, opacity: 1, background: 'var(--modal-bg, #ffffff)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <h3 style={{ fontWeight: 'bold' }}>Add Currency</h3>
              <button onClick={() => setShowAdd(false)} aria-label="Close add currency dialog" title="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}><X size={18} /></button>
            </div>
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              <select className="input-field" aria-label="Select currency" value={manualEntry ? 'manual' : form.code} onChange={handleCurrencySelection} disabled={catalogLoading}>
                <option value="">{catalogLoading ? 'Loading currencies…' : 'Select a currency'}</option>
                {availableCurrencies.map((currency) => <option key={currency.code} value={currency.code}>{currency.name} ({currency.code})</option>)}
                <option value="manual">Enter manually</option>
              </select>
              {catalogError && <div role="status" style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{catalogError}</div>}
              <input className="input-field" aria-label="Currency code" placeholder="Code (e.g. JPY)" value={form.code} readOnly={!manualEntry} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
              <input className="input-field" aria-label="Currency symbol" placeholder="Symbol (e.g. ¥)" value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} />
              <input className="input-field" aria-label="Currency name" placeholder="Name (e.g. Japanese Yen)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Exchange rate: 1 {catalog?.baseCode || baseCode || 'USD'} = X {form.code || 'units'}</label>
              <input className="input-field" aria-label="Exchange rate" type="number" min="0" step="any" placeholder="Exchange rate" value={form.exchangeRate} onChange={(e) => setForm({ ...form, exchangeRate: e.target.value })} />
              {catalog?.asOf && !manualEntry && form.code && <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>Published rate as of {catalog.asOf}. You can edit it before creating.</div>}
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
