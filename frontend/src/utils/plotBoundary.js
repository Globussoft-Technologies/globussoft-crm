const SQ_METERS_TO_SQ_FEET = 10.76391041671;
const EARTH_RADIUS_M = 6378137;

function normalizeLongitudeDelta(delta) {
  if (delta > Math.PI) return delta - (2 * Math.PI);
  if (delta < -Math.PI) return delta + (2 * Math.PI);
  return delta;
}

export function calculateBoundaryAreaSqFt(points = []) {
  if (!Array.isArray(points) || points.length < 3) return null;
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const lat1 = Number(current.latitude) * Math.PI / 180;
    const lat2 = Number(next.latitude) * Math.PI / 180;
    const lng1 = Number(current.longitude) * Math.PI / 180;
    const lng2 = Number(next.longitude) * Math.PI / 180;
    if (![lat1, lat2, lng1, lng2].every(Number.isFinite)) return null;
    sum += normalizeLongitudeDelta(lng2 - lng1) * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  const squareMeters = Math.abs(sum * EARTH_RADIUS_M * EARTH_RADIUS_M / 2);
  return squareMeters > 0 ? squareMeters * SQ_METERS_TO_SQ_FEET : null;
}

export function coordinatesToText(points = []) {
  return points.map((point) => `${Number(point.latitude).toFixed(7)}, ${Number(point.longitude).toFixed(7)}`).join('\n');
}

export function parseCoordinateText(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const points = lines.map((line, index) => {
    const values = line.split(/[\s,]+/).filter(Boolean);
    const latitude = Number(values[0]);
    const longitude = Number(values[1]);
    if (values.length !== 2 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new Error(`Line ${index + 1} must contain a valid latitude and longitude.`);
    }
    return { latitude, longitude };
  });
  if (points.length < 3) throw new Error('Enter at least 3 boundary points.');
  return points;
}
