/**
 * SVG GeoJSON-extrusion map tile — a 100% custom, branded, adaptive "board-game
 * tile" map. Projects a destination country's boundary to 2D, fakes a 3D extrude
 * (offset accent-dark side wall under an accent top face), and overlays
 * coordinate-accurate city pins + a dotted route polyline. No map API, no WebGL —
 * pure inline SVG that prints natively and recolours from the accent alone.
 *
 * Country polygons: bundled Natural Earth 110m (public domain), slimmed to
 * { n:name, i:ISO2, g:geometry }. Coarse on purpose — we want a clean silhouette,
 * not a detailed coastline.
 */
import countriesData from './data/countries-110m.json';

export interface LL {
  name: string;
  lon: number;
  lat: number;
}

export interface Feat {
  n: string;
  i: string;
  g: { type: string; coordinates: number[] | number[][] | number[][][] | number[][][][] };
}

const FEATURES = (countriesData as { features: Feat[] }).features;

/** Outer rings of a Polygon / MultiPolygon (holes ignored — fine for our use). */
function outerRings(geom: Feat['g']): number[][][] {
  if (geom.type === 'Polygon') return [(geom.coordinates as number[][][])[0]!];
  if (geom.type === 'MultiPolygon') return (geom.coordinates as number[][][][]).map((p) => p[0]!);
  return [];
}

function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!,
      yi = ring[i]![1]!,
      xj = ring[j]![0]!,
      yj = ring[j]![1]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inCountry(lon: number, lat: number, f: Feat): boolean {
  return outerRings(f.g).some((r) => pointInRing(lon, lat, r));
}

function bbox(f: Feat): [number, number, number, number] {
  let mnx = Infinity,
    mny = Infinity,
    mxx = -Infinity,
    mxy = -Infinity;
  for (const r of outerRings(f.g))
    for (const [lo, la] of r) {
      if (lo! < mnx) mnx = lo!;
      if (lo! > mxx) mxx = lo!;
      if (la! < mny) mny = la!;
      if (la! > mxy) mxy = la!;
    }
  return [mnx, mny, mxx, mxy];
}

/**
 * Resolve the destination country: a name hint ("Tokyo, Japan" → "Japan") first,
 * then the polygon containing the most city points, then a bbox match. null → the
 * caller should fall back to the raster map.
 */
export function findCountry(points: LL[], hintNames: string[]): Feat | null {
  // 1) name hints — TALLY per country and take the majority. A round-trip's first stop
  //    is often the home/departure country (e.g. "Bangalore, India" before a Saudi
  //    pilgrimage), so trusting the FIRST hint picks the wrong country; the country named
  //    by the MOST stops is the real destination.
  const tally = new Map<Feat, number>();
  for (const h of hintNames) {
    const q = String(h).split(',').pop()!.trim().toLowerCase();
    if (q.length < 3) continue;
    const f =
      FEATURES.find((ff) => ff.n.toLowerCase() === q) ||
      FEATURES.find((ff) => ff.n.toLowerCase().includes(q) || q.includes(ff.n.toLowerCase()));
    if (f) tally.set(f, (tally.get(f) ?? 0) + 1);
  }
  let hintBest: Feat | null = null;
  let hintCount = 0;
  for (const [f, c] of tally) {
    if (c > hintCount) {
      hintCount = c;
      hintBest = f;
    }
  }
  if (hintBest) return hintBest;
  // 2) polygon containment, by most points
  let best: Feat | null = null;
  let bestCount = 0;
  for (const f of FEATURES) {
    let cnt = 0;
    for (const p of points) if (inCountry(p.lon, p.lat, f)) cnt++;
    if (cnt > bestCount) {
      bestCount = cnt;
      best = f;
    }
  }
  if (best) return best;
  // 3) bbox fallback (coastal cities can fall just outside coarse 110m polygons)
  let bb: Feat | null = null;
  let bbCount = 0;
  for (const f of FEATURES) {
    const [mnx, mny, mxx, mxy] = bbox(f);
    let cnt = 0;
    for (const p of points) if (p.lon >= mnx && p.lon <= mxx && p.lat >= mny && p.lat <= mxy) cnt++;
    if (cnt > bbCount) {
      bbCount = cnt;
      bb = f;
    }
  }
  return bb;
}

export interface TileColors {
  accent: string;
  accentDeep: string;
  onAccent: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Frame {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

export interface CountryRender {
  /** SVG markup for the country silhouette, clipped to the zone (in the caller's units). */
  paths: string;
  /** Project a lon/lat to the same coordinate space as `paths` (for pins/labels/lines). */
  project: (lon: number, lat: number) => [number, number];
  /** Vertical extrude depth (so callers can clear the side wall). */
  depth: number;
}

/** Geographic bounding box [minLon, minLat, maxLon, maxLat] of a country (outer rings). */
export function countryBbox(country: Feat): [number, number, number, number] {
  return bbox(country);
}

/**
 * Project a country into a caller-supplied rectangle using a caller-supplied GEOGRAPHIC
 * FRAME (already aspect-matched to the zone). The frame maps EXACTLY onto the zone — so
 * the caller can "zoom to the route" (frame ≈ the cities' bbox) to spread clustered
 * cities and fill the zone with no letterbox, while parts of the country outside the
 * frame are CLIPPED to the zone (a clean map-window, never bleeding under the callout
 * cards). Returns the projector so pins/labels/leaders land coordinate-accurately.
 * `clipId` must be unique per page or multiple map pages share one clip and mis-render.
 * Returns null if the geometry is unusable.
 */
export function renderCountryFramed(
  country: Feat,
  zone: Rect,
  frame: Frame,
  col: TileColors,
  clipId: string,
): CountryRender | null {
  const rings = outerRings(country.g);
  if (!rings.length) return null;

  const { minLon, maxLon, minLat, maxLat } = frame;
  const kx = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180) || 1;
  const frameW = (maxLon - minLon) * kx || 1;
  // The frame is aspect-matched to the zone by the caller, so this single scale fills
  // both axes; min() is a defensive guard against a near-miss match (avoids overflow).
  const s = Math.min(zone.w / frameW, zone.h / (maxLat - minLat || 1));
  const depth = Math.min(zone.w, zone.h) * 0.035;

  const project = (lo: number, la: number): [number, number] => [
    zone.x + (lo - minLon) * kx * s,
    zone.y + (maxLat - la) * s,
  ];
  const n = (v: number) => v.toFixed(2);
  const d = rings
    .map(
      (r) =>
        'M' +
        r
          .map(([lo, la]) => {
            const [x, y] = project(lo!, la!);
            return `${n(x)},${n(y)}`;
          })
          .join('L') +
        'Z',
    )
    .join(' ');
  const sw = Math.max(0.6, Math.min(zone.w, zone.h) * 0.006);
  const rx = Math.min(zone.w, zone.h) * 0.035;
  const id = `mapclip-${clipId}`;
  const paths =
    `<defs><clipPath id="${id}"><rect x="${n(zone.x)}" y="${n(zone.y)}" width="${n(zone.w)}" height="${n(zone.h)}" rx="${n(rx)}"/></clipPath></defs>` +
    `<g clip-path="url(#${id})">` +
    `<path d="${d}" transform="translate(0,${n(depth)})" fill="${col.accentDeep}"/>` +
    `<path d="${d}" fill="${col.accent}" stroke="${col.accentDeep}" stroke-width="${n(sw)}" stroke-linejoin="round"/>` +
    `</g>`;
  return { paths, project, depth };
}
