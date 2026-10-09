import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, Filter, MapPin, Plus, RefreshCw, Save, Search, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import ResizableTableHeader from '../components/ResizableTableHeader';
import AddressAutocomplete from '../components/AddressAutocomplete';
import useResizableColumnWidths from '../utils/useResizableColumnWidths';
import { googleMapsCoordinateUrl, googleMapsSearchUrl, openPreciseGoogleMap } from '../utils/googleMaps';

const PICKUP_INVENTORY_COLUMNS = [
  { label: 'S.No.', width: 80, minWidth: 70 },
  { label: 'Pickup location', width: 160, minWidth: 120 },
  { label: 'Pickup address', width: 285, minWidth: 180 },
  { label: 'Assigned', width: 90, minWidth: 80 },
  { label: 'Maximum limit', width: 180, minWidth: 145 },
  { label: 'Created at', width: 140, minWidth: 120 },
  { label: 'Updated at', width: 140, minWidth: 120 },
  { label: 'Google Map', width: 125, minWidth: 110 },
];

function mapsUrl(location) {
  return location.googleMapsLink
    || googleMapsSearchUrl(location.address);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

export default function PickupInventory() {
  const notify = useNotify();
  const [locations, setLocations] = useState([]);
  const [limits, setLimits] = useState({});
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState(null);
  const [addingLocation, setAddingLocation] = useState(false);
  const [savingLocation, setSavingLocation] = useState(false);
  const [newLocation, setNewLocation] = useState({ name: '', address: '', googleMapsLink: '', maxAssignments: '' });
  const { columnWidths, resizeColumn, tableMinWidth } = useResizableColumnWidths(
    PICKUP_INVENTORY_COLUMNS,
    'pickup-inventory-column-widths',
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetchApi('/api/pickup-plot-inventory');
      const rows = Array.isArray(response?.pickupLocations) ? response.pickupLocations : [];
      setLocations(rows);
      setLimits(Object.fromEntries(rows.map((row) => [row.id, row.maxAssignments ?? ''])));
    } catch (loadError) {
      setError(loadError?.message || 'Could not load pickup inventory.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filteredLocations = useMemo(() => {
    const query = search.trim().toLowerCase();
    return locations.filter((location) => {
      const matchesSearch = !query || [location.name, location.address]
        .some((value) => String(value || '').toLowerCase().includes(query));
      const isActive = location.isActive !== false;
      const matchesStatus = statusFilter === 'all'
        || (statusFilter === 'active' && isActive)
        || (statusFilter === 'inactive' && !isActive);
      return matchesSearch && matchesStatus;
    });
  }, [locations, search, statusFilter]);

  const saveLimit = async (location) => {
    const rawLimit = limits[location.id];
    const maxAssignments = rawLimit === '' ? null : Number(rawLimit);
    if (maxAssignments !== null && (!Number.isInteger(maxAssignments) || maxAssignments <= 0)) {
      notify.error('Maximum assignments must be a positive whole number.');
      return;
    }
    setSavingId(location.id);
    try {
      const updated = await fetchApi(`/api/pickup-plot-inventory/locations/${location.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: location.name,
          address: location.address,
          googleMapsLink: location.googleMapsLink || '',
          notes: location.notes || '',
          isActive: location.isActive !== false,
          maxAssignments,
        }),
      });
      setLocations((current) => current.map((row) => (
        row.id === location.id ? { ...row, ...updated, assignedCount: row.assignedCount ?? row.plotCount ?? 0 } : row
      )));
      notify.success('Pickup location limit updated.');
    } catch (saveError) {
      notify.error(saveError?.message || 'Could not update the pickup location limit.');
    } finally {
      setSavingId(null);
    }
  };

  const openAddLocation = () => {
    setNewLocation({ name: '', address: '', googleMapsLink: '', maxAssignments: '' });
    setAddingLocation(true);
  };

  const saveNewLocation = async (event) => {
    event.preventDefault();
    const name = newLocation.name.trim();
    const address = newLocation.address.trim();
    const rawLimit = newLocation.maxAssignments;
    const maxAssignments = rawLimit === '' ? null : Number(rawLimit);
    if (!name) return notify.error('Enter a pickup location name.');
    if (address.length < 5) return notify.error('Enter a valid pickup address.');
    if (maxAssignments !== null && (!Number.isInteger(maxAssignments) || maxAssignments <= 0)) {
      return notify.error('Maximum assignments must be a positive whole number.');
    }
    setSavingLocation(true);
    try {
      await fetchApi('/api/pickup-plot-inventory/locations', {
        method: 'POST',
        body: JSON.stringify({
          name,
          address,
          googleMapsLink: newLocation.googleMapsLink,
          maxAssignments,
          notes: '',
          isActive: true,
        }),
      });
      notify.success('Pickup location added.');
      setAddingLocation(false);
      await load();
    } catch (saveError) {
      notify.error(saveError?.message || 'Could not add the pickup location.');
    } finally {
      setSavingLocation(false);
    }
  };

  return (
    <div data-testid="pickup-inventory-page" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden', boxSizing: 'border-box', padding: '2rem', animation: 'fadeIn .35s ease-out' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16, marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}><MapPin size={28} /> Pickup Inventory</h1>
          <p style={{ margin: '0.4rem 0 0', color: 'var(--text-secondary)' }}>Track pickup-address capacity, assignments, dates, and map locations.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flex: '1 1 620px', maxWidth: 900, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end' }}>
          <label style={{ position: 'relative', flex: '1 1 240px', minWidth: 220 }}>
            <Search size={16} aria-hidden="true" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
            <input className="input-field" type="search" aria-label="Search pickup inventory" placeholder="Search pickup locations..." value={search} onChange={(event) => setSearch(event.target.value)} style={{ width: '100%', height: 44, boxSizing: 'border-box', paddingLeft: 36 }} />
          </label>
          <label style={{ position: 'relative', flex: '0 0 150px' }}>
            <Filter size={15} aria-hidden="true" style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)', pointerEvents: 'none' }} />
            <select
              className="input-field"
              aria-label="Filter pickup locations by status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              style={{ width: '100%', height: 44, boxSizing: 'border-box', paddingLeft: 34 }}
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>
          <button type="button" className="btn-secondary" onClick={load} disabled={loading} style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap' }}><RefreshCw size={15} /> Refresh</button>
          <button type="button" className="btn-primary" onClick={openAddLocation} style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap' }}><Plus size={15} /> Add Pickup Location</button>
        </div>
      </header>

      {error && <div role="alert" className="card" style={{ padding: '1rem', color: 'var(--danger-color, #dc2626)' }}>{error}</div>}
      {loading ? <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading pickup inventory…</div> : (
        <div
          className="card pickup-plot-table-scroll"
          data-testid="pickup-inventory-table-scroll"
          style={{
            flex: '1 1 0', minHeight: 0, width: '100%', maxWidth: '100%',
            overflowX: 'auto', overflowY: 'auto', padding: 0, boxSizing: 'border-box',
            scrollbarGutter: 'stable', overscrollBehavior: 'contain',
          }}
        >
          <div data-testid="pickup-inventory-table-width" style={{ width: tableMinWidth, minWidth: '100%' }}>
          <table className="pickup-plot-resizable-table" style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse' }}>
            <colgroup>{columnWidths.map((width, index) => <col key={PICKUP_INVENTORY_COLUMNS[index].label} style={{ width }} />)}</colgroup>
            <thead><tr>{PICKUP_INVENTORY_COLUMNS.map((column, index) => (
              <ResizableTableHeader
                key={column.label}
                label={column.label}
                width={columnWidths[index]}
                minWidth={column.minWidth}
                onResize={(width) => resizeColumn(index, width)}
                style={headerStyle}
              >
                {column.label}
              </ResizableTableHeader>
            ))}</tr></thead>
            <tbody>
              {filteredLocations.map((location, index) => {
                const assignedCount = Number(location.assignedCount ?? location.plotCount ?? 0);
                return <tr key={location.id}>
                  <td style={cellStyle}>{index + 1}</td>
                  <td style={cellStyle}><strong>{location.name}</strong><small style={{ display: 'block', marginTop: 3, color: location.isActive ? '#047857' : 'var(--text-secondary)' }}>{location.isActive ? 'Active' : 'Inactive'}</small></td>
                  <td style={{ ...cellStyle, minWidth: 280 }}>
                    <a
                      href={mapsUrl(location)}
                      onClick={(event) => { void openPreciseGoogleMap(event, location); }}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open pickup address for ${location.name} in Google Maps`}
                      title="Open pickup address in Google Maps"
                      style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 7, color: 'inherit', textDecoration: 'none', lineHeight: 1.45 }}
                    >
                      <MapPin size={16} aria-hidden="true" style={{ flex: '0 0 auto', marginTop: 2, color: 'var(--primary-color, var(--accent-color))' }} />
                      <span style={{ overflowWrap: 'anywhere' }}>{location.address}</span>
                    </a>
                  </td>
                  <td style={cellStyle}><strong>{assignedCount} plot{assignedCount === 1 ? '' : 's'}</strong></td>
                  <td style={cellStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input className="input-field" aria-label={`Maximum assignments for ${location.name}`} type="number" min="1" step="1" placeholder="No limit" value={limits[location.id] ?? ''} onChange={(event) => setLimits((current) => ({ ...current, [location.id]: event.target.value }))} style={{ width: 105 }} />
                      <button type="button" className="btn-secondary" aria-label={`Save maximum assignments for ${location.name}`} disabled={savingId === location.id} onClick={() => saveLimit(location)}><Save size={14} /></button>
                    </div>
                  </td>
                  <td style={cellStyle}>{formatDate(location.createdAt)}</td>
                  <td style={cellStyle}>{formatDate(location.updatedAt)}</td>
                  <td style={{ ...cellStyle, textAlign: 'right' }}><a className="btn-secondary" href={mapsUrl(location)} onClick={(event) => { void openPreciseGoogleMap(event, location); }} target="_blank" rel="noreferrer" aria-label={`Open ${location.name} in Google Maps`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}><ExternalLink size={14} /> Open map</a></td>
                </tr>;
              })}
              {filteredLocations.length === 0 && <tr><td colSpan="8" style={{ padding: '2.5rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No pickup locations found.</td></tr>}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {addingLocation && (
        <div role="presentation" style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(15,23,42,.48)', display: 'grid', placeItems: 'center', padding: 16 }}>
          <form role="dialog" aria-modal="true" aria-labelledby="add-pickup-location-title" className="card" onSubmit={saveNewLocation} style={{ width: 'min(560px, 100%)', padding: '1.25rem', opacity: 1, background: 'var(--popover-bg, #fff)', backdropFilter: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <h2 id="add-pickup-location-title" style={{ margin: 0, fontSize: '1.2rem' }}>Add pickup location</h2>
              <button type="button" className="btn-secondary" aria-label="Close add pickup location" onClick={() => setAddingLocation(false)} style={{ padding: '.4rem' }}><X size={17} /></button>
            </div>
            <div style={{ display: 'grid', gap: 14, marginTop: 18 }}>
              <label style={{ display: 'grid', gap: 6, fontSize: '.78rem', fontWeight: 700, color: 'var(--text-secondary)' }}>Location name
                <input className="input-field" aria-label="Location name" required maxLength={150} value={newLocation.name} onChange={(event) => setNewLocation((current) => ({ ...current, name: event.target.value }))} placeholder="e.g. Bangalore Palace" />
              </label>
              <AddressAutocomplete
                label="Pickup address"
                placeholder="Start typing a pickup location address..."
                value={newLocation.address}
                onChange={(address) => setNewLocation((current) => ({ ...current, address, googleMapsLink: '' }))}
                onSelect={(suggestion) => setNewLocation((current) => ({
                  ...current,
                  googleMapsLink: googleMapsCoordinateUrl(suggestion.lat, suggestion.lng),
                }))}
              />
              <label style={{ display: 'grid', gap: 6, fontSize: '.78rem', fontWeight: 700, color: 'var(--text-secondary)' }}>Maximum assignments
                <input className="input-field" aria-label="Maximum assignments" type="number" min="1" step="1" placeholder="No limit" value={newLocation.maxAssignments} onChange={(event) => setNewLocation((current) => ({ ...current, maxAssignments: event.target.value }))} />
              </label>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button type="button" className="btn-secondary" onClick={() => setAddingLocation(false)}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={savingLocation}>{savingLocation ? 'Saving…' : 'Add location'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

const headerStyle = { position: 'sticky', top: 0, zIndex: 2, padding: '0.8rem', textAlign: 'left', whiteSpace: 'nowrap', color: 'var(--text-secondary)', background: '#f3f4f6', borderRight: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)', boxShadow: '0 1px 0 var(--border-color)', fontSize: '0.78rem' };
const cellStyle = { padding: '0.85rem', verticalAlign: 'middle', borderRight: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)', overflowWrap: 'anywhere' };
