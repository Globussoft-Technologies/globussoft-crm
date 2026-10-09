import { MapPin } from 'lucide-react';
import { googleMapsSearchUrl, openPreciseGoogleMap } from '../utils/googleMaps';

function defaultMapUrl(location) {
  return location.googleMapsLink
    || googleMapsSearchUrl(location.address || location.name);
}

export default function CompactPickupLocationCell({
  locations,
  contextLabel,
  emptyLabel = 'Not assigned',
  getMapUrl = defaultMapUrl,
}) {
  const availableLocations = Array.isArray(locations)
    ? locations.filter((location) => location?.id || location?.address || location?.name)
    : [];
  if (availableLocations.length === 0) return <span>{emptyLabel}</span>;

  return (
    <div
      aria-label={`Pickup locations for ${contextLabel}`}
      style={{ display: 'grid', gap: 8, maxHeight: 104, overflowY: 'auto', overscrollBehavior: 'contain', paddingRight: 4, minWidth: 0 }}
    >
      {availableLocations.map((location) => {
        const locationLabel = location.name || location.address || 'Pickup location';
        return <a
          key={location.id || location.address}
          href={getMapUrl(location)}
          onClick={(event) => { void openPreciseGoogleMap(event, location); }}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${locationLabel} pickup location in Google Maps`}
          style={{ display: 'flex', alignItems: 'flex-start', gap: 6, color: 'inherit', textDecoration: 'none', minWidth: 0 }}
        >
          <MapPin size={14} aria-hidden="true" style={{ flex: '0 0 auto', marginTop: 2, color: 'var(--primary-color, var(--accent-color))' }} />
          <span style={{ minWidth: 0 }}>
            {location.name && <strong style={{ display: 'block', fontSize: '.8rem', overflowWrap: 'anywhere' }}>{location.name}</strong>}
            {location.address && <span style={{ display: 'block', color: 'var(--text-secondary)', fontSize: '.76rem', lineHeight: 1.35, overflowWrap: 'anywhere' }}>{location.address}</span>}
          </span>
        </a>;
      })}
    </div>
  );
}
