import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Edit2,
  Eye,
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
import MultiSelectDropdown from '../components/MultiSelectDropdown';
import ResizableTableHeader from '../components/ResizableTableHeader';
import CompactPickupLocationCell from '../components/CompactPickupLocationCell';
import useResizableColumnWidths from '../utils/useResizableColumnWidths';
import { googleMapsSearchUrl, openPreciseGoogleMap } from '../utils/googleMaps';

const EMPTY_PLOT = {
  name: '', plotNumber: '', block: '', address: '', area: '', areaUnit: 'SQ_FT', price: '',
  roadWidth: '', facing: '', propertyType: '',
  availability: 'AVAILABLE', notes: '', isActive: true, boundary: [], pickupLocationIds: [],
};
const AVAILABILITY = ['AVAILABLE', 'HOLD', 'BOOKED', 'REGISTERED', 'RESERVED', 'SOLD'];
const PLOT_AREA_UNIT_OPTIONS = [
  { value: 'SQ_FT', label: 'Sq. ft.' },
  { value: 'KATHA', label: 'Katha' },
];
const FACING_OPTIONS = [
  ['NORTH', 'North'], ['SOUTH', 'South'], ['EAST', 'East'], ['WEST', 'West'],
  ['NORTH_EAST', 'North East'], ['NORTH_WEST', 'North West'],
  ['SOUTH_EAST', 'South East'], ['SOUTH_WEST', 'South West'],
];
const PROPERTY_TYPE_OPTIONS = [
  ['RESIDENTIAL', 'Residential'], ['COMMERCIAL', 'Commercial'],
];
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
const PLOT_INVENTORY_COLUMNS = [
  { label: 'S.No.', width: 80, minWidth: 70 },
  { label: 'Plot / Site', width: 185, minWidth: 120 },
  { label: 'Plot number', width: 140, minWidth: 105 },
  { label: 'Block', width: 140, minWidth: 90 },
  { label: 'Address', width: 275, minWidth: 180 },
  { label: 'Pickup locations', width: 275, minWidth: 180 },
  { label: 'Area', width: 160, minWidth: 140 },
  { label: 'Price', width: 205, minWidth: 175 },
  { label: 'Availability', width: 205, minWidth: 170 },
  { label: 'Road width', width: 160, minWidth: 110 },
  { label: 'Facing', width: 160, minWidth: 100 },
  { label: 'Type', width: 160, minWidth: 100 },
  { label: 'Status', width: 115, minWidth: 90 },
  { label: 'Actions', width: 110, minWidth: 90 },
];

const fieldStyle = { width: '100%', marginTop: 5, boxSizing: 'border-box' };
const labelStyle = { display: 'block', fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-secondary)' };
const plotTableHeaderStyle = {
  padding: '0.55rem 0.75rem', textAlign: 'left', fontSize: '0.78rem',
  color: 'var(--text-secondary)',
  background: '#f3f4f6',
  borderRight: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)', whiteSpace: 'normal', overflowWrap: 'anywhere',
  position: 'sticky', top: 0, zIndex: 1,
};
const plotTableCellStyle = {
  padding: '0.8rem 0.75rem', textAlign: 'left', verticalAlign: 'middle',
  borderRight: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)', whiteSpace: 'normal',
  overflowWrap: 'anywhere', textOverflow: 'clip',
};
const columnFilterLabelStyle = {
  display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, whiteSpace: 'nowrap',
};

function plotMapUrl(address) {
  return googleMapsSearchUrl(address);
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

function storedArea(plot) {
  if (!plot?.area || !plot.areaUnit) return plot?.area;
  return `${plot.area} ${plot.areaUnit === 'KATHA' ? 'katha' : 'sq ft'}`;
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
      onClick={(event) => { void openPreciseGoogleMap(event, plot); }}
      target="_blank"
      rel="noreferrer"
      aria-label={`Show ${plot.name} address on Google Maps`}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 8,
        color: 'inherit', textDecoration: 'none',
      }}
    >
      <MapPin size={15} aria-hidden="true" style={{ flex: '0 0 auto', marginTop: 2, color: 'var(--primary-color, var(--accent-color))' }} />
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', lineHeight: 1.45, overflowWrap: 'anywhere' }}>{address}</span>
        <span style={{ display: 'block', marginTop: 3, color: 'var(--text-secondary)', fontSize: '0.72rem', fontWeight: 700 }}>
          {formatArea(plot.boundaryAreaSqFt, areaUnit, locale)
            ? `Mapped: ${formatArea(plot.boundaryAreaSqFt, areaUnit, locale)}`
            : formatArea(storedArea(plot), areaUnit, locale) ? `Area: ${formatArea(storedArea(plot), areaUnit, locale)}` : 'Open address location'}
        </span>
      </span>
    </a>
  );
}

function PlotPickupLocations({ plot }) {
  const locations = Array.isArray(plot.pickupLocations)
    ? plot.pickupLocations.filter((location) => location?.address)
    : plot.pickupLocation?.address ? [plot.pickupLocation] : [];
  return <CompactPickupLocationCell
    locations={locations}
    contextLabel={plot.name || 'plot or site'}
    emptyLabel="—"
  />;
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
          {formatArea(storedArea(plot), areaUnit, locale) && <span>Recorded area: <strong style={{ color: 'var(--text-primary)' }}>{formatArea(storedArea(plot), areaUnit, locale)}</strong></span>}
          <span>Survey points: <strong style={{ color: 'var(--text-primary)' }}>{plot.boundary.length}</strong></span>
        </div>
      </div>
    </div>
  );
}

export default function PickupPlotInventory() {
  const { tenant } = useContext(AuthContext);
  const notify = useNotify();
  const [data, setData] = useState({ plots: [], pickupLocations: [], summary: {} });
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
  const { columnWidths, resizeColumn, tableMinWidth } = useResizableColumnWidths(
    PLOT_INVENTORY_COLUMNS,
    'plot-inventory-column-widths',
  );
  const plotTableViewportRef = useRef(null);
  const locale = tenant?.locale || 'en-US';
  const activePickupLocations = useMemo(
    () => data.pickupLocations.filter((location) => location.isActive),
    [data.pickupLocations],
  );
  const selectedPickupLocations = useMemo(() => {
    const selectedIds = new Set((plotForm.pickupLocationIds || []).map(Number));
    return data.pickupLocations.filter((location) => selectedIds.has(Number(location.id)));
  }, [data.pickupLocations, plotForm.pickupLocationIds]);

  const loadInventory = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const response = await fetchApi('/api/pickup-plot-inventory');
      setData({
        plots: Array.isArray(response?.plots) ? response.plots : [],
        pickupLocations: Array.isArray(response?.pickupLocations) ? response.pickupLocations : [],
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
    const area = config.areaUnit ? areaInUnit(storedArea(plot), config.areaUnit) : null;
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
      name: plot.name || '', plotNumber: plot.plotNumber || '', block: plot.block || '',
      address: plot.address || '', area: plot.area || '', areaUnit: plot.areaUnit || 'SQ_FT',
      roadWidth: plot.roadWidth || '', facing: plot.facing || '', propertyType: plot.propertyType || '',
      price: plot.price ?? '', availability: plot.availability || 'AVAILABLE',
      notes: plot.notes || '', isActive: plot.isActive !== false,
      boundary: Array.isArray(plot.boundary) ? plot.boundary : [],
      pickupLocationIds: Array.isArray(plot.pickupLocationIds)
        ? plot.pickupLocationIds.map(Number)
        : plot.pickupLocationId ? [Number(plot.pickupLocationId)] : [],
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
      plot.name, plot.plotNumber, plot.block, plot.address, plot.area, plot.areaUnit,
      plot.price, plot.roadWidth, plot.facing, plot.propertyType, plot.availability, plot.notes,
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
        <div aria-label="Inventory filters" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flex: '1 1 520px', maxWidth: 760 }}>
          <input
            className="input-field"
            type="search"
            aria-label="Search plots and sites"
            placeholder="Search plots and sites..."
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            style={{ flex: '1 1 210px', minWidth: 0, height: 44, boxSizing: 'border-box' }}
          />
          <ScrollableSelect
            ariaLabel="Filter by status"
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUS_FILTER_OPTIONS}
            maxVisibleRows={4}
            width={130}
          />
          <button className="btn-primary" onClick={() => openPlot()} style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap' }}>
            <Plus size={16} /> Add Plot / Site
          </button>
        </div>
      </header>

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
          className="card pickup-plot-table-scroll"
          data-testid="plot-inventory-table"
          style={{
            flex: '1 1 auto', minHeight: 0, maxHeight: '100%', width: '100%', maxWidth: '100%',
            boxSizing: 'border-box', overflowX: 'auto', overflowY: 'auto', padding: 0,
            scrollbarGutter: 'stable', overscrollBehavior: 'contain',
          }}
        >
          <div data-testid="plot-inventory-table-width" style={{ width: tableMinWidth, minWidth: '100%' }}>
          <table key="plot-inventory-layout-v2" className="stable-table pickup-plot-resizable-table" style={{ display: 'table', overflow: 'visible', width: '100%', height: 'auto', tableLayout: 'fixed', borderCollapse: 'collapse' }}>
            <colgroup>
              {columnWidths.map((width, index) => <col key={PLOT_INVENTORY_COLUMNS[index].label} style={{ width }} />)}
            </colgroup>
            <thead><tr>
              {PLOT_INVENTORY_COLUMNS.slice(0, 6).map((column, index) => <ResizableTableHeader key={column.label} label={column.label} width={columnWidths[index]} minWidth={column.minWidth} onResize={(width) => resizeColumn(index, width)} style={plotTableHeaderStyle}>{column.label}</ResizableTableHeader>)}
              <ResizableTableHeader label="Area" width={columnWidths[6]} minWidth={PLOT_INVENTORY_COLUMNS[6].minWidth} onResize={(width) => resizeColumn(6, width)} style={plotTableHeaderStyle}>
                <label style={columnFilterLabelStyle}>Area:
                  <ScrollableSelect ariaLabel="Area unit" value={areaUnit} onChange={setAreaUnit} options={AREA_UNIT_OPTIONS} maxVisibleRows={4} width={105} compact />
                </label>
              </ResizableTableHeader>
              <ResizableTableHeader label="Price" width={columnWidths[7]} minWidth={PLOT_INVENTORY_COLUMNS[7].minWidth} onResize={(width) => resizeColumn(7, width)} style={plotTableHeaderStyle}>
                <label style={columnFilterLabelStyle}>Price:
                  <ScrollableSelect ariaLabel="Price unit" value={priceUnit} onChange={setPriceUnit} options={PRICE_UNIT_OPTIONS} maxVisibleRows={4} width={145} compact />
                </label>
              </ResizableTableHeader>
              <ResizableTableHeader label="Availability" width={columnWidths[8]} minWidth={PLOT_INVENTORY_COLUMNS[8].minWidth} onResize={(width) => resizeColumn(8, width)} style={plotTableHeaderStyle}>
                <label style={columnFilterLabelStyle}>Availability:
                  <ScrollableSelect ariaLabel="Filter by availability" value={availabilityFilter} onChange={setAvailabilityFilter} options={AVAILABILITY_FILTER_OPTIONS} maxVisibleRows={4} width={95} compact />
                </label>
              </ResizableTableHeader>
              {PLOT_INVENTORY_COLUMNS.slice(9).map((column, offset) => {
                const index = offset + 9;
                return <ResizableTableHeader key={column.label} label={column.label} width={columnWidths[index]} minWidth={column.minWidth} onResize={(width) => resizeColumn(index, width)} style={plotTableHeaderStyle}>{column.label}</ResizableTableHeader>;
              })}
            </tr></thead>
            <tbody>
              {filteredPlots.map((plot, index) => (
                <tr key={plot.id} style={{ opacity: plot.isActive ? 1 : 0.62 }}>
                  <td style={plotTableCellStyle}>{index + 1}</td>
                  <td style={plotTableCellStyle}><strong>{plot.name}</strong></td>
                  <td style={plotTableCellStyle}>{plot.plotNumber || '—'}</td>
                  <td style={plotTableCellStyle}>{plot.block || '—'}</td>
                  <td style={plotTableCellStyle}>
                    <PlotAddress plot={plot} areaUnit={areaUnit} locale={locale} />
                    {Array.isArray(plot.boundary) && plot.boundary.length >= 3 && <button
                      type="button"
                      className="btn-secondary"
                      aria-label={`View highlighted boundary for ${plot.name}`}
                      onClick={() => setBoundaryPreview(plot)}
                      style={{ display: 'inline-flex', marginTop: 6, padding: '0.35rem 0.5rem', fontSize: '0.74rem' }}
                    >
                      <Eye size={13} /> Highlight area
                    </button>}
                  </td>
                  <td style={plotTableCellStyle}><PlotPickupLocations plot={plot} /></td>
                  <td style={plotTableCellStyle}>
                    <span>{formatArea(storedArea(plot), areaUnit, locale) || '—'}</span>
                    {formatArea(plot.boundaryAreaSqFt, areaUnit, locale) && <small style={{ display: 'block', marginTop: 3, color: 'var(--text-secondary)' }}>Mapped: {formatArea(plot.boundaryAreaSqFt, areaUnit, locale)}</small>}
                  </td>
                  <td style={plotTableCellStyle}>{formatPrice(plot)}</td>
                  <td style={plotTableCellStyle}><StatusPill active={plot.availability === 'AVAILABLE'}>{plot.availability}</StatusPill></td>
                  <td style={plotTableCellStyle}>{plot.roadWidth || '—'}</td>
                  <td style={plotTableCellStyle}>{plot.facing ? plot.facing.replaceAll('_', ' ') : '—'}</td>
                  <td style={plotTableCellStyle}>{plot.propertyType || '—'}</td>
                  <td style={plotTableCellStyle}>{plot.isActive ? 'Active' : 'Inactive'}</td>
                  <td style={plotTableCellStyle}><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <button className="btn-secondary" aria-label={`Edit ${plot.name}`} onClick={() => openPlot(plot)}><Edit2 size={14} /></button>
                    <button className="btn-secondary" aria-label={`${plot.isActive ? 'Deactivate' : 'Activate'} ${plot.name}`} onClick={() => toggleStatus(plot)}><Power size={14} /></button>
                  </div></td>
                </tr>
              ))}
              {data.plots.length === 0 && <tr><td colSpan="14" style={{ ...plotTableCellStyle, textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>No plots or sites yet.</td></tr>}
              {data.plots.length > 0 && filteredPlots.length === 0 && <tr><td colSpan="14" style={{ ...plotTableCellStyle, textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>No plots or sites match the selected filters.</td></tr>}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {plotDialog && <Modal title={plotDialog.id ? 'Edit Plot / Site' : 'Add Plot / Site'} onClose={() => setPlotDialog(null)} onSave={savePlot} saving={saving} wide>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 14 }}>
          <label style={labelStyle}>Name *<input className="input-field" required minLength="2" maxLength="150" style={fieldStyle} value={plotForm.name} onChange={(event) => setPlotForm({ ...plotForm, name: event.target.value })} /></label>
          <label style={labelStyle}>Plot number<input className="input-field" maxLength="100" style={fieldStyle} value={plotForm.plotNumber} onChange={(event) => setPlotForm({ ...plotForm, plotNumber: event.target.value })} /></label>
          <label style={labelStyle}>Block<input className="input-field" maxLength="100" style={fieldStyle} value={plotForm.block} onChange={(event) => setPlotForm({ ...plotForm, block: event.target.value })} /></label>
          <label style={labelStyle}>Availability<select className="input-field" style={fieldStyle} value={plotForm.availability} onChange={(event) => setPlotForm({ ...plotForm, availability: event.target.value })}>{AVAILABILITY.map((status) => <option key={status}>{status}</option>)}</select></label>
          <label style={labelStyle}>Area<input className="input-field" maxLength="100" placeholder="e.g. 1,200" style={fieldStyle} value={plotForm.area} onChange={(event) => setPlotForm({ ...plotForm, area: event.target.value })} /></label>
          <label style={labelStyle}>Area unit<select className="input-field" style={fieldStyle} value={plotForm.areaUnit} onChange={(event) => setPlotForm({ ...plotForm, areaUnit: event.target.value })}>{PLOT_AREA_UNIT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label style={labelStyle}>Price<input className="input-field" type="number" min="0" max="9999999999999.99" step="0.01" style={fieldStyle} value={plotForm.price} onChange={(event) => setPlotForm({ ...plotForm, price: event.target.value })} /></label>
          <label style={labelStyle}>Road width<input className="input-field" maxLength="100" placeholder="e.g. 30 ft" style={fieldStyle} value={plotForm.roadWidth} onChange={(event) => setPlotForm({ ...plotForm, roadWidth: event.target.value })} /></label>
          <label style={labelStyle}>Facing<select className="input-field" style={fieldStyle} value={plotForm.facing} onChange={(event) => setPlotForm({ ...plotForm, facing: event.target.value })}><option value="">Select facing</option>{FACING_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label style={labelStyle}>Residential / Commercial<select className="input-field" style={fieldStyle} value={plotForm.propertyType} onChange={(event) => setPlotForm({ ...plotForm, propertyType: event.target.value })}><option value="">Select type</option>{PROPERTY_TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <div style={{ gridColumn: '1 / -1', minWidth: 0 }}>
            <div style={{ ...labelStyle, marginBottom: 5 }}>Pickup locations (select multiple)</div>
            <MultiSelectDropdown
              ariaLabel="Pickup locations (select multiple)"
              searchable
              options={activePickupLocations.map((location) => ({
                value: Number(location.id), label: `${location.name} · ${location.address}`,
              }))}
              selected={(plotForm.pickupLocationIds || []).map(Number)}
              onChange={(pickupLocationIds) => setPlotForm((current) => ({ ...current, pickupLocationIds }))}
              placeholder="Select one or more pickup locations"
            />
            {selectedPickupLocations.length > 0 && <div aria-label="Selected pickup locations" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {selectedPickupLocations.map((location) => <span key={location.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: '100%', padding: '0.28rem 0.5rem', borderRadius: 999, background: 'var(--primary-light, rgba(79, 70, 229, .1))', color: 'var(--text-primary)', fontSize: '.76rem' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{location.name}</span>
                <button
                  type="button"
                  aria-label={`Remove pickup location ${location.name}`}
                  onClick={() => setPlotForm((current) => ({
                    ...current,
                    pickupLocationIds: (current.pickupLocationIds || []).map(Number).filter((id) => id !== Number(location.id)),
                  }))}
                  style={{ display: 'inline-flex', padding: 0, border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer' }}
                >
                  <X size={13} />
                </button>
              </span>)}
            </div>}
            <div style={{ marginTop: 5, color: 'var(--text-secondary)', fontSize: '.76rem' }}>
              Open the dropdown and tick every required location. Only active locations added in Pickup Inventory are available here.
            </div>
            {activePickupLocations.length === 0 && <div style={{ marginTop: 5, color: 'var(--text-secondary)', fontSize: '.76rem' }}>No active pickup locations are available. Add one in Pickup Inventory first.</div>}
          </div>
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
