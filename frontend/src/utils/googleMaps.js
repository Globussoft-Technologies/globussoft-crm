import { geocodeSuggest } from '../lib/geocoder';

export function googleMapsSearchUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(String(address || '').trim())}`;
}

export function googleMapsCoordinateUrl(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return '';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`;
}

export async function openPreciseGoogleMap(event, location) {
  if (location?.googleMapsLink) return;

  event.preventDefault();
  const fallbackUrl = googleMapsSearchUrl(location?.address || location?.name);
  const mapWindow = window.open('about:blank', '_blank');
  if (mapWindow) mapWindow.opener = null;

  let destination = fallbackUrl;
  try {
    const [suggestion] = await geocodeSuggest(String(location?.address || '').trim(), 1);
    destination = googleMapsCoordinateUrl(suggestion?.lat, suggestion?.lng) || fallbackUrl;
  } catch {
    // Keep the address-search fallback when the geocoder is temporarily unavailable.
  }

  if (mapWindow && !mapWindow.closed) {
    mapWindow.location.replace(destination);
  } else {
    window.open(destination, '_blank', 'noopener,noreferrer');
  }
}
