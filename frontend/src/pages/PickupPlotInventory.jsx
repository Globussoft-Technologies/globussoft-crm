import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Edit2,
  Eye,
  ExternalLink,
  MapPin,
  Plus,
  Power,
  X,
} from 'lucide-react';
import { AuthContext } from '../App';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { validatePlotForm } from '../utils/pickupPlotValidation';
import PlotBoundaryMap from '../components/PlotBoundaryMap';
import ScrollableSelect from '../components/ScrollableSelect';
import AddressAutocomplete from '../components/AddressAutocomplete';

const EMPTY_PLOT = {
  name: '', address: '', area: '', price: '',
  availability: 'AVAILABLE', notes: '', isActive: true, boundary: [],
};
const AVAILABILITY = ['AVAILABLE', 'RESERVED', 'SOLD'];
const AREA_UNITS = {
  SQ_FT: { label: 'Sq. Ft. (ft²)', shortLabel: 'sq ft', sqFt: 1 },
  SQ_M: { label: 'Sq. M. (m²)', shortLabel: 'sq m', sqFt: 10.7639104167 },
  SQ_YD: { label: 'Sq. Yd. (yd² / Gaj)', shortLabel: 'sq yd', sqFt: 9 },
  ACRE: { label: 'Acre', shortLabel: 'acre', sqFt: 43560 },
  HECTARE: { label: 'Hectare', shortLabel: 'hectare', sqFt: 107639.104167 },
  CENT: { label: 'Cent', shortLabel: 'cent', sqFt: 435.6 },
  GUNTHA: { label: 'Guntha / Gunta', shortLabel: 'guntha', sqFt: 1089 },
  GROUND: { label: 'Ground', shortLabel: 'ground', sqFt: 2400 },
  ANKANAM: { label: 'Ankanam', shortLabel: 'ankanam', sqFt: 72 },
  KANAL: { label: 'Kanal', shortLabel: 'kanal', sqFt: 5445 },
  MARLA: { label: 'Marla', shortLabel: 'marla', sqFt: 272.25 },
  BIGHA: { label: 'Bigha (regional)', shortLabel: 'bigha', sqFt: 27000 },
  KATHA: { label: 'Katha (regional)', shortLabel: 'katha', sqFt: 1361.25 },
  BISWA: { label: 'Biswa (regional)', shortLabel: 'biswa', sqFt: 1350 },
  DECIMAL: { label: 'Decimal', shortLabel: 'decimal', sqFt: 435.6 },
};
const PRICE_UNITS = {
  TOTAL: { label: '₹ (INR)' },
  PER_SQ_FT: { label: '₹ / Sq. Ft.', areaUnit: 'SQ_FT' },
  PER_SQ_YD: { label: '₹ / Sq. Yd.', areaUnit: 'SQ_YD' },
  PER_SQ_M: { label: '₹ / Sq. M.', areaUnit: 'SQ_M' },
  PER_CENT: { label: '₹ / Cent', areaUnit: 'CENT' },
  PER_GUNTHA: { label: '₹ / Guntha', areaUnit: 'GUNTHA' },
  PER_ACRE: { label: '₹ / Acre', areaUnit: 'ACRE' },
  PER_HECTARE: { label: '₹ / Hectare', areaUnit: 'HECTARE' },
  PER_GROUND: { label: '₹ / Ground', areaUnit: 'GROUND' },
  PER_ANKANAM: { label: '₹ / Ankanam', areaUnit: 'ANKANAM' },
};
const AREA_UNIT_OPTIONS = Object.entries(AREA_UNITS).map(([value, config]) => ({ value, label: config.label }));
const PRICE_UNIT_OPTIONS = Object.entries(PRICE_UNITS).map(([value, config]) => ({ value, label: config.label }));
const STATUS_FILTER_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];
const AVAILABILITY_FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  ...AVAILABILITY.map((status) => ({ value: status, label: status[0] + status.slice(1).toLowerCase() })),
];

const fieldStyle = { width: '100%', marginTop: 5, boxSizing: 'border-box' };
const labelStyle = { display: 'block', fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-secondary)' };
const plotTableHeaderStyle = {
  padding: '0.55rem 0.75rem', textAlign: 'left', fontSize: '0.78rem',
  color: 'var(--text-secondary)',
  background: 'linear-gradient(var(--table-header-bg, rgba(148,163,184,.08)), var(--table-header-bg, rgba(148,163,184,.08))), var(--popover-bg, #fff)',
  borderBottom: '1px solid var(--border-color)', whiteSpace: 'normal', overflowWrap: 'anywhere',
  position: 'sticky', top: 0, zIndex: 1,
};
const plotTableCellStyle = {
  padding: '0.8rem 0.75rem', textAlign: 'left', verticalAlign: 'middle',
  borderBottom: '1px solid var(--border-color)', whiteSpace: 'normal',
  overflowWrap: 'anywhere', textOverflow: 'clip',
};
const columnFilterLabelStyle = {
  display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, whiteSpace: 'nowrap',
};

function plotMapUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address.trim())}`;
}

function areaInSquareFeet(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim().toLowerCase().replace(/,/g, '');
  const amount = Number.parseFloat(normalized);
  if (!Number.isFinite(amount) || amount < 0) return null;
  if (/\b(?:hectare|hectares|ha)\b/.test(normalized)) return amount * AREA_UNITS.HECTARE.sqFt;
  if (/\b(?:acre|acres|ac)\b/.test(normalized)) return amount * AREA_UNITS.ACRE.sqFt;
  if (/(?:sq\.?\s*(?:m|meter|metre)|sqm|m[²2])/.test(normalized)) return amount * AREA_UNITS.SQ_M.sqFt;
  if (/(?:sq\.?\s*(?:yd|yard)|sqyd|yd[²2])/.test(normalized)) return amount * AREA_UNITS.SQ_YD.sqFt;
  if (/\b(?:cent|cents)\b/.test(normalized)) return amount * AREA_UNITS.CENT.sqFt;
  if (/\b(?:guntha|gunta|gunthas|guntas)\b/.test(normalized)) return amount * AREA_UNITS.GUNTHA.sqFt;
  if (/\b(?:ground|grounds)\b/.test(normalized)) return amount * AREA_UNITS.GROUND.sqFt;
  if (/\b(?:ankanam|ankanams)\b/.test(normalized)) return amount * AREA_UNITS.ANKANAM.sqFt;
  if (/\b(?:kanal|kanals)\b/.test(normalized)) return amount * AREA_UNITS.KANAL.sqFt;
  if (/\b(?:marla|marlas)\b/.test(normalized)) return amount * AREA_UNITS.MARLA.sqFt;
  if (/\b(?:bigha|bighas)\b/.test(normalized)) return amount * AREA_UNITS.BIGHA.sqFt;
  if (/\b(?:katha|kathas)\b/.test(normalized)) return amount * AREA_UNITS.KATHA.sqFt;
  if (/\b(?:biswa|biswas)\b/.test(normalized)) return amount * AREA_UNITS.BISWA.sqFt;
  if (/\b(?:decimal|decimals)\b/.test(normalized)) return amount * AREA_UNITS.DECIMAL.sqFt;
  return amount;
}

function areaInUnit(value, unit) {
  const squareFeet = areaInSquareFeet(value);
  return squareFeet === null ? null : squareFeet / AREA_UNITS[unit].sqFt;
}

function formatArea(value, unit, locale = 'en-US') {
  const converted = areaInUnit(value, unit);
  if (converted === null) return null;
  const maximumFractionDigits = converted >= 100 ? 0 : converted >= 10 ? 1 : 2;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits }).format(converted)} ${AREA_UNITS[unit].shortLabel}`;
}

function PlotAddress({ plot, areaUnit, locale }) {
  const address = plot.address?.trim();
  if (!address) return <span aria-label="No address available">&mdash;</span>;

  return (
    <a
      href={plotMapUrl(address)}
      target="_blank"
      rel="noreferrer"
      aria-label={`Show ${plot.name} address on Google Maps`}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 8, padding: '0.55rem 0.65rem',
        color: 'inherit', textDecoration: 'none', borderRadius: 8,
        borderLeft: '3px solid var(--primary-color, var(--accent-color))',
        background: 'color-mix(in srgb, var(--primary-color, var(--accent-color)) 10%, transparent)',
      }}
    >
      <MapPin size={15} aria-hidden="true" style={{ flex: '0 0 auto', marginTop: 2, color: 'var(--primary-color, var(--accent-color))' }} />
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', lineHeight: 1.45, overflowWrap: 'anywhere' }}>{address}</span>
        <span style={{ display: 'block', marginTop: 3, color: 'var(--text-secondary)', fontSize: '0.72rem', fontWeight: 700 }}>
          {formatArea(plot.boundaryAreaSqFt, areaUnit, locale)
            ? `Mapped: ${formatArea(plot.boundaryAreaSqFt, areaUnit, locale)}`
            : formatArea(plot.area, areaUnit, locale) ? `Area: ${formatArea(plot.area, areaUnit, locale)}` : 'Open address location'}
        </span>
      </span>
    </a>
  );
}

function PlotMapLink({ plot, onOpen }) {
  const address = plot.address?.trim();
  const hasBoundary = Array.isArray(plot.boundary) && plot.boundary.length >= 3;

  if (hasBoundary) {
    return (
      <button
        type="button"
        className="btn-secondary"
        aria-label={`View highlighted boundary for ${plot.name}`}
        onClick={() => onOpen(plot)}
        style={{ display: 'inline-flex', padding: '0.45rem 0.6rem', fontSize: '0.78rem' }}
      >
        <Eye size={14} /> Highlight area
      </button>
    );
  }
  if (!address) return <span aria-label="No map available">&mdash;</span>;

  return (
    <a
      href={plotMapUrl(address)}
      target="_blank"
      rel="noreferrer"
      className="btn-secondary"
      aria-label={`View ${plot.name} on Google Maps`}
      style={{ display: 'inline-flex', padding: '0.45rem 0.6rem', textDecoration: 'none', fontSize: '0.78rem' }}
    >
      <MapPin size={14} /> Show area <ExternalLink size={12} />
    </a>
  );
}

function StatusPill({ active, children }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '0.2rem 0.55rem',
      borderRadius: 999, fontSize: '0.74rem', fontWeight: 700,
      color: active ? '#047857' : '#64748b',
      background: active ? 'rgba(16,185,129,.14)' : 'rgba(100,116,139,.14)',
    }}>
      {children}
    </span>
  );
}

function Modal({ title, onClose, children, onSave, saving, wide = false }) {
  return (
    <div role="presentation" style={{ position: 'fixed', inset: 0, zIndex: 300, padding: '1rem', background: 'rgba(15,23,42,.62)', display: 'grid', placeItems: 'center' }}>
      <div role="dialog" aria-modal="true" aria-label={title} className="card" style={{ width: wide ? 'min(920px, 100%)' : 'min(620px, 100%)', maxHeight: '90vh', overflowY: 'auto', padding: '1.5rem', background: 'var(--modal-bg, #fff)', color: 'var(--text-primary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: '1.25rem' }}>
          <h2 style={{ margin: 0, fontSize: '1.25rem' }}>{title}</h2>
          <button type="button" aria-label="Close dialog" onClick={onClose} style={{ border: 0, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}><X size={21} /></button>
        </div>
        {children}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: '1.4rem' }}>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="btn-primary" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

function BoundaryPreview({ plot, areaUnit, locale, onClose }) {
  return (
    <div role="presentation" style={{ position: 'fixed', inset: 0, zIndex: 300, padding: '1rem', background: 'rgba(15,23,42,.62)', display: 'grid', placeItems: 'center' }}>
      <div role="dialog" aria-modal="true" aria-label={`${plot.name} highlighted boundary`} className="card" style={{ width: 'min(900px, 100%)', maxHeight: '90vh', overflowY: 'auto', padding: '1.25rem', background: 'var(--modal-bg, #fff)', color: 'var(--text-primary)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0 }}>{plot.name}</h2>
            <p style={{ margin: '4px 0 0', color: 'var(--text-secondary)' }}>{plot.address || 'GPS survey boundary'}</p>
          </div>
          <button type="button" aria-label="Close boundary map" onClick={onClose} style={{ border: 0, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}><X size={21} /></button>
        </div>
        <PlotBoundaryMap boundary={plot.boundary} areaSqFt={plot.boundaryAreaSqFt} height={500} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 12, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
          {formatArea(plot.area, areaUnit, locale) && <span>Recorded area: <strong style={{ color: 'var(--text-primary)' }}>{formatArea(plot.area, areaUnit, locale)}</strong></span>}
          <span>Survey points: <strong style={{ color: 'var(--text-primary)' }}>{plot.boundary.length}</strong></span>
        </div>
      </div>
    </div>
  );
}

export default function PickupPlotInventory() {
  const { tenant } = useContext(AuthContext);
  const notify = useNotify();
  const [data, setData] = useState({ plots: [], summary: {} });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [plotDialog, setPlotDialog] = useState(null);
  const [boundaryPreview, setBoundaryPreview] = useState(null);
  const [plotForm, setPlotForm] = useState(EMPTY_PLOT);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [availabilityFilter, setAvailabilityFilter] = useState('all');
  const [areaUnit, setAreaUnit] = useState('SQ_FT');
  const [priceUnit, setPriceUnit] = useState('TOTAL');
  const plotTableViewportRef = useRef(null);
  const locale = tenant?.locale || 'en-US';

  const loadInventory = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const response = await fetchApi('/api/pickup-plot-inventory');
      setData({
        plots: Array.isArray(response?.plots) ? response.plots : [],
        summary: response?.summary || {},
      });
    } catch (error) {
      const message = error.message || 'The inventory service could not be reached.';
      setLoadError(message);
      notify.error(`Could not load pickup and plot inventory. ${message}`);
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { loadInventory(); }, [loadInventory]);

  useEffect(() => {
    if (plotTableViewportRef.current) {
      plotTableViewportRef.current.scrollLeft = 0;
    }
  }, [data.plots]);

  const formatPrice = (plot) => {
    if (plot.price === null || plot.price === undefined || plot.price === '') return '—';
    const config = PRICE_UNITS[priceUnit];
    const totalPrice = Number(plot.price);
    const area = config.areaUnit ? areaInUnit(plot.area, config.areaUnit) : null;
    const amount = config.areaUnit ? totalPrice / area : totalPrice;
    if (!Number.isFinite(amount)) return '—';
    const formatted = new Intl.NumberFormat(locale, {
      style: 'currency', currency: 'INR', maximumFractionDigits: 2,
    }).format(amount);
    return config.areaUnit ? `${formatted} / ${AREA_UNITS[config.areaUnit].shortLabel}` : formatted;
  };

  const openPlot = (plot = null) => {
    setPlotDialog(plot || {});
    setPlotForm(plot ? {
      name: plot.name || '', address: plot.address || '', area: plot.area || '',
      price: plot.price ?? '', availability: plot.availability || 'AVAILABLE',
      notes: plot.notes || '', isActive: plot.isActive !== false,
      boundary: Array.isArray(plot.boundary) ? plot.boundary : [],
    } : { ...EMPTY_PLOT });
  };

  const savePlot = async () => {
    const validationError = validatePlotForm(plotForm);
    if (validationError) {
      notify.error(validationError);
      return;
    }
    if (plotForm.boundary.length > 0 && plotForm.boundary.length < 3) {
      notify.error('Add at least 3 GPS points to close the plot boundary, or clear it.');
      return;
    }
    setSaving(true);
    try {
      const editing = Boolean(plotDialog?.id);
      await fetchApi(`/api/pickup-plot-inventory/plots${editing ? `/${plotDialog.id}` : ''}`, {
        method: editing ? 'PUT' : 'POST',
        body: JSON.stringify(plotForm),
      });
      notify.success(editing ? 'Plot or site updated.' : 'Plot or site added.');
      setPlotDialog(null);
      await loadInventory();
    } catch (error) {
      notify.error(error.message || 'Could not save plot or site.');
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (row) => {
    try {
      await fetchApi(`/api/pickup-plot-inventory/plots/${row.id}/status`, {
        method: 'PATCH', body: JSON.stringify({ isActive: !row.isActive }),
      });
      notify.success(`Plot or site ${row.isActive ? 'deactivated' : 'activated'}.`);
      await loadInventory();
    } catch (error) {
      notify.error(error.message || 'Could not change status.');
    }
  };

  const summaryCards = [
    ['Total active plots/sites', data.summary.totalPlots || 0],
    ['Available', data.summary.availablePlots || 0],
    ['Reserved', data.summary.reservedPlots || 0],
    ['Sold', data.summary.soldPlots || 0],
  ];

  const matchesSharedFilters = useCallback((row, searchableValues) => {
    if (statusFilter === 'active' && !row.isActive) return false;
    if (statusFilter === 'inactive' && row.isActive) return false;
    const query = searchQuery.trim().toLowerCase();
    if (!query) return true;
    return searchableValues.some((value) => String(value ?? '').toLowerCase().includes(query));
  }, [searchQuery, statusFilter]);

  const filteredPlots = useMemo(() => data.plots.filter((plot) => {
    if (availabilityFilter !== 'all' && plot.availability !== availabilityFilter) return false;
    return matchesSharedFilters(plot, [
      plot.name, plot.address, plot.area, plot.price, plot.availability, plot.notes,
    ]);
  }), [availabilityFilter, data.plots, matchesSharedFilters]);

  return (
    <div
      data-testid="pickup-plot-inventory-page"
      style={{
        display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
        overflow: 'hidden', boxSizing: 'border-box', padding: '2rem',
        animation: 'fadeIn .35s ease-out',
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16, marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}><MapPin size={28} /> Plot & Site Inventory</h1>
          <p style={{ color: 'var(--text-secondary)', margin: '0.4rem 0 0' }}>Track the availability, area, price, and location of plots and sites.</p>
        </div>
        <div aria-label="Inventory filters" style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, flex: '1 1 520px', maxWidth: 760 }}>
          <input
            className="input-field"
            type="search"
            aria-label="Search plots and sites"
            placeholder="Search plots and sites..."
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            style={{ flex: '1 1 210px', minWidth: 0 }}
          />
          <ScrollableSelect
            ariaLabel="Filter by status"
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUS_FILTER_OPTIONS}
            maxVisibleRows={4}
            width={130}
          />
          <button className="btn-primary" onClick={() => openPlot()}>
            <Plus size={16} /> Add Plot / Site
          </button>
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 170px), 1fr))', gap: 12, marginBottom: '1.25rem' }}>
        {summaryCards.map(([label, value]) => (
          <div key={label} className="card" style={{ padding: '1rem' }}>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.76rem', fontWeight: 700 }}>{label}</div>
            <div style={{ fontSize: '1.65rem', fontWeight: 800, marginTop: 4 }}>{value}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading inventory…</div>
      ) : loadError ? (
        <div role="alert" className="card" style={{ padding: '2rem', textAlign: 'center' }}>
          <strong>Inventory could not be loaded.</strong>
          <p style={{ color: 'var(--text-secondary)', margin: '0.6rem 0 1rem' }}>{loadError}</p>
          <button type="button" className="btn-primary" onClick={loadInventory}>Retry</button>
        </div>
      ) : (
        <div
          ref={plotTableViewportRef}
          className="card"
          data-testid="plot-inventory-table"
          style={{
            flex: '1 1 0', minHeight: 0, width: '100%', maxWidth: '100%',
            boxSizing: 'border-box', overflowX: 'hidden', overflowY: 'auto', padding: 0,
            scrollbarGutter: 'stable', overscrollBehavior: 'contain',
          }}
        >
          <table className="stable-table" style={{ display: 'table', overflow: 'visible', width: '100%', minWidth: 0, maxWidth: '100%', tableLayout: 'fixed', borderCollapse: 'collapse' }}>
            <colgroup>
              <col style={{ width: '14%' }} />
              <col style={{ width: '16%' }} />
              <col style={{ width: '13%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '13%' }} />
              <col style={{ width: '13%' }} />
              <col style={{ width: '9%' }} />
              <col style={{ width: '12%' }} />
            </colgroup>
            <thead><tr>
              {['Plot / Site', 'Address', 'Map'].map((heading) => <th key={heading} style={plotTableHeaderStyle}>{heading}</th>)}
              <th style={plotTableHeaderStyle}>
                <label style={columnFilterLabelStyle}>Area:
                  <ScrollableSelect ariaLabel="Area unit" value={areaUnit} onChange={setAreaUnit} options={AREA_UNIT_OPTIONS} maxVisibleRows={4} width={105} compact />
                </label>
              </th>
              <th style={plotTableHeaderStyle}>
                <label style={columnFilterLabelStyle}>Price:
                  <ScrollableSelect ariaLabel="Price unit" value={priceUnit} onChange={setPriceUnit} options={PRICE_UNIT_OPTIONS} maxVisibleRows={4} width={145} compact />
                </label>
              </th>
              <th style={plotTableHeaderStyle}>
                <label style={columnFilterLabelStyle}>Availability:
                  <ScrollableSelect ariaLabel="Filter by availability" value={availabilityFilter} onChange={setAvailabilityFilter} options={AVAILABILITY_FILTER_OPTIONS} maxVisibleRows={4} width={95} compact />
                </label>
              </th>
              {['Status', 'Actions'].map((heading) => <th key={heading} style={plotTableHeaderStyle}>{heading}</th>)}
            </tr></thead>
            <tbody>
              {filteredPlots.map((plot) => (
                <tr key={plot.id} style={{ opacity: plot.isActive ? 1 : 0.62 }}>
                  <td style={plotTableCellStyle}><strong>{plot.name}</strong></td>
                  <td style={plotTableCellStyle}><PlotAddress plot={plot} areaUnit={areaUnit} locale={locale} /></td>
                  <td style={plotTableCellStyle}><PlotMapLink plot={plot} onOpen={setBoundaryPreview} /></td>
                  <td style={plotTableCellStyle}>
                    <span>{formatArea(plot.area, areaUnit, locale) || '—'}</span>
                    {formatArea(plot.boundaryAreaSqFt, areaUnit, locale) && <small style={{ display: 'block', marginTop: 3, color: 'var(--text-secondary)' }}>Mapped: {formatArea(plot.boundaryAreaSqFt, areaUnit, locale)}</small>}
                  </td>
                  <td style={plotTableCellStyle}>{formatPrice(plot)}</td>
                  <td style={plotTableCellStyle}><StatusPill active={plot.availability === 'AVAILABLE'}>{plot.availability}</StatusPill></td>
                  <td style={plotTableCellStyle}>{plot.isActive ? 'Active' : 'Inactive'}</td>
                  <td style={plotTableCellStyle}><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button className="btn-secondary" aria-label={`Edit ${plot.name}`} onClick={() => openPlot(plot)}><Edit2 size={14} /></button>
                    <button className="btn-secondary" aria-label={`${plot.isActive ? 'Deactivate' : 'Activate'} ${plot.name}`} onClick={() => toggleStatus(plot)}><Power size={14} /></button>
                  </div></td>
                </tr>
              ))}
              {data.plots.length === 0 && <tr><td colSpan="8" style={{ ...plotTableCellStyle, textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>No plots or sites yet.</td></tr>}
              {data.plots.length > 0 && filteredPlots.length === 0 && <tr><td colSpan="8" style={{ ...plotTableCellStyle, textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>No plots or sites match the selected filters.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {plotDialog && <Modal title={plotDialog.id ? 'Edit Plot / Site' : 'Add Plot / Site'} onClose={() => setPlotDialog(null)} onSave={savePlot} saving={saving} wide>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 14 }}>
          <label style={labelStyle}>Name *<input className="input-field" required minLength="2" maxLength="150" style={fieldStyle} value={plotForm.name} onChange={(event) => setPlotForm({ ...plotForm, name: event.target.value })} /></label>
          <label style={labelStyle}>Availability<select className="input-field" style={fieldStyle} value={plotForm.availability} onChange={(event) => setPlotForm({ ...plotForm, availability: event.target.value })}>{AVAILABILITY.map((status) => <option key={status}>{status}</option>)}</select></label>
          <label style={labelStyle}>Area / size<input className="input-field" maxLength="100" placeholder="e.g. 1,200 sq ft" style={fieldStyle} value={plotForm.area} onChange={(event) => setPlotForm({ ...plotForm, area: event.target.value })} /></label>
          <label style={labelStyle}>Price<input className="input-field" type="number" min="0" max="9999999999999.99" step="0.01" style={fieldStyle} value={plotForm.price} onChange={(event) => setPlotForm({ ...plotForm, price: event.target.value })} /></label>
          <AddressAutocomplete
            style={{ gridColumn: '1 / -1' }}
            value={plotForm.address}
            onChange={(address) => setPlotForm((current) => ({ ...current, address }))}
          />
          <label style={{ ...labelStyle, gridColumn: '1 / -1' }}>Notes<textarea className="input-field" maxLength="4000" rows="3" style={fieldStyle} value={plotForm.notes} onChange={(event) => setPlotForm({ ...plotForm, notes: event.target.value })} /></label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', gridColumn: '1 / -1' }}><input type="checkbox" checked={plotForm.isActive} onChange={(event) => setPlotForm({ ...plotForm, isActive: event.target.checked })} /> Active inventory item</label>
        </div>
      </Modal>}
      {boundaryPreview && <BoundaryPreview plot={boundaryPreview} areaUnit={areaUnit} locale={locale} onClose={() => setBoundaryPreview(null)} />}
    </div>
  );
}
