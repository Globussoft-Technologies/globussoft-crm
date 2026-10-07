const EARTH_RADIUS_M = 6378137;
const SQ_METERS_TO_SQ_FEET = 10.76391041671;
const MAX_BOUNDARY_POINTS = 200;

function normalizeLongitudeDelta(delta) {
  if (delta > Math.PI) return delta - (2 * Math.PI);
  if (delta < -Math.PI) return delta + (2 * Math.PI);
  return delta;
}

function normalizeBoundary(input) {
  if (input === null || input === undefined || input === "") return [];

  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw Object.assign(new Error("Boundary must be valid JSON"), { code: "INVALID_BOUNDARY" });
    }
  }
  if (!Array.isArray(value)) {
    throw Object.assign(new Error("Boundary must be an array of GPS coordinates"), { code: "INVALID_BOUNDARY" });
  }
  if (value.length === 0) return [];
  if (value.length < 3 || value.length > MAX_BOUNDARY_POINTS) {
    throw Object.assign(new Error(`Boundary must contain 3 to ${MAX_BOUNDARY_POINTS} points`), { code: "INVALID_BOUNDARY" });
  }

  const points = value.map((point, index) => {
    const latitude = Number(Array.isArray(point) ? point[0] : point?.latitude ?? point?.lat);
    const longitude = Number(Array.isArray(point) ? point[1] : point?.longitude ?? point?.lng);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw Object.assign(new Error(`Boundary point ${index + 1} has invalid latitude or longitude`), { code: "INVALID_BOUNDARY" });
    }
    return { latitude, longitude };
  });

  const first = points[0];
  const last = points[points.length - 1];
  if (points.length > 3 && first.latitude === last.latitude && first.longitude === last.longitude) {
    points.pop();
  }
  if (points.length < 3 || new Set(points.map((point) => `${point.latitude},${point.longitude}`)).size < 3) {
    throw Object.assign(new Error("Boundary needs at least 3 distinct points"), { code: "INVALID_BOUNDARY" });
  }
  return points;
}

// Chamberlain-Duquette spherical polygon area. It is accurate enough for
// cadastral-size plots while remaining stable for polygons spanning a map tile.
function calculateBoundaryAreaSqFt(pointsInput) {
  const points = normalizeBoundary(pointsInput);
  if (points.length < 3) return null;

  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const lat1 = current.latitude * Math.PI / 180;
    const lat2 = next.latitude * Math.PI / 180;
    const lng1 = current.longitude * Math.PI / 180;
    const lng2 = next.longitude * Math.PI / 180;
    sum += normalizeLongitudeDelta(lng2 - lng1) * (2 + Math.sin(lat1) + Math.sin(lat2));
  }

  const squareMeters = Math.abs(sum * EARTH_RADIUS_M * EARTH_RADIUS_M / 2);
  if (!Number.isFinite(squareMeters) || squareMeters <= 0) {
    throw Object.assign(new Error("Boundary points must enclose a measurable area"), { code: "INVALID_BOUNDARY" });
  }
  return Math.round(squareMeters * SQ_METERS_TO_SQ_FEET * 100) / 100;
}

function parseStoredBoundary(value) {
  if (!value) return [];
  try {
    return normalizeBoundary(value);
  } catch {
    return [];
  }
}

module.exports = {
  MAX_BOUNDARY_POINTS,
  normalizeBoundary,
  calculateBoundaryAreaSqFt,
  parseStoredBoundary,
};
