/**
 * Asset resolver — finds/builds URLs for real photos, AI imagery, and QR codes
 * from FREE sources. Used by the `image_search` tool (real photos) and referenced
 * by designer prompts (keyless AI-image / QR URLs the model builds inline).
 *
 * API keys are OPTIONAL and read from the environment (never logged). Every path
 * has a keyless fallback, so the system works with zero keys configured:
 *   PEXELS_API_KEY     — free, instant: https://www.pexels.com/api/
 *   UNSPLASH_API_KEY   — free: https://unsplash.com/developers
 *   HUGGINGFACE_API_KEY — optional, FLUX.1-schnell (else Pollinations is used)
 * Keyless sources used when no key is set: Openverse + Wikimedia Commons (photos),
 * Pollinations/Flux (AI images), goQR (QR codes).
 */

function envKey(name: string): string {
  return (process.env[name] ?? '').trim();
}

const UA = 'AgenticOS/1.0 (brochure asset fetcher)';

export interface PhotoResult {
  url: string;
  source: string;
  alt?: string;
}

/**
 * Real photo search with a graceful free-source fallback chain:
 * Pexels (key) -> Unsplash (key) -> Openverse (keyless) -> Wikimedia (keyless).
 * Returns direct image URLs suitable for an <img src>.
 */
export async function searchPhotos(query: string, count = 4): Promise<PhotoResult[]> {
  const q = query.trim();
  if (!q) return [];
  const n = Math.min(Math.max(Math.floor(count), 1), 10);

  // 1) Pexels — free key, high quality.
  const pexels = envKey('PEXELS_API_KEY');
  if (pexels) {
    const r = await tryJson(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=${n}&orientation=landscape`,
      { headers: { Authorization: pexels } },
    );
    const out = ((r?.photos as any[]) ?? [])
      .map((p) => ({ url: p?.src?.large2x || p?.src?.large || p?.src?.original, source: 'pexels', alt: p?.alt }))
      .filter((p) => p.url);
    if (out.length) return out.slice(0, n);
  }

  // 2) Unsplash — free key.
  const unsplash = envKey('UNSPLASH_API_KEY');
  if (unsplash) {
    const r = await tryJson(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=${n}&orientation=landscape&client_id=${unsplash}`,
    );
    const out = ((r?.results as any[]) ?? [])
      .map((p) => ({ url: p?.urls?.regular, source: 'unsplash', alt: p?.alt_description }))
      .filter((p) => p.url);
    if (out.length) return out.slice(0, n);
  }

  // 3) Openverse — keyless, commercially-licensed CC media.
  const ov = await tryJson(
    `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=${n}&license_type=commercial&mature=false`,
  );
  const ovOut = ((ov?.results as any[]) ?? [])
    .map((p) => ({ url: p?.url, source: 'openverse', alt: p?.title }))
    .filter((p) => p.url);
  if (ovOut.length) return ovOut.slice(0, n);

  // 4) Wikimedia Commons — keyless, great for named landmarks.
  return wikimediaSearch(q, n);
}

async function wikimediaSearch(query: string, n: number): Promise<PhotoResult[]> {
  const api =
    `https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*` +
    `&generator=search&gsrsearch=${encodeURIComponent('filetype:bitmap ' + query)}` +
    `&gsrnamespace=6&gsrlimit=${n}&prop=imageinfo&iiprop=url&iiurlwidth=1280`;
  const r = await tryJson(api);
  const pages = r?.query?.pages ? Object.values(r.query.pages) : [];
  return (pages as any[])
    .map((p) => ({
      url: p?.imageinfo?.[0]?.thumburl || p?.imageinfo?.[0]?.url,
      source: 'wikimedia',
      alt: p?.title,
    }))
    .filter((p) => p.url)
    .slice(0, n);
}

async function tryJson(url: string, init?: { headers?: Record<string, string> }): Promise<any | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(init?.headers ?? {}) },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Keyless AI-image URL (Pollinations, which serves Flux). The designer can also
 * build these inline; exposed here for callers that want a ready URL.
 */
export function aiImageUrl(
  prompt: string,
  opts?: { width?: number; height?: number; model?: string },
): string {
  const width = opts?.width ?? 1280;
  const height = opts?.height ?? 960;
  const model = opts?.model ?? 'flux';
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&model=${model}&nologo=true`;
}

/** Keyless QR-code image URL (goQR). */
export function qrUrl(data: string, size = 300): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(data)}`;
}

export interface GeoPoint {
  name: string;
  lat: number;
  lon: number;
}

/** True when a static-map key is configured (Geoapify). The 2D basemap needs it. */
export function hasStaticMap(): boolean {
  return !!envKey('GEOAPIFY_API_KEY');
}

/**
 * Clean Web-Mercator basemap URL (Geoapify Static Maps) for a given centre + zoom +
 * pixel size — NO provider markers or route (the engine overlays its own, accurately,
 * using the SAME Mercator projection so they land on the map). Returns '' if no key.
 * Standard 256px-tile Web Mercator, so center+zoom is reproducible by the caller's
 * own projector. `scale=2` is requested for crisp print via retina tiles.
 */
export function staticMapUrl(opts: {
  center: { lon: number; lat: number };
  zoom: number;
  width: number;
  height: number;
  style?: string;
}): string {
  const key = envKey('GEOAPIFY_API_KEY');
  if (!key) return '';
  const style = opts.style ?? 'osm-bright-smooth';
  const w = Math.min(Math.max(Math.round(opts.width), 100), 2000);
  const h = Math.min(Math.max(Math.round(opts.height), 100), 2000);
  const z = Math.round(opts.zoom * 1000) / 1000;
  const c = `lonlat:${opts.center.lon.toFixed(5)},${opts.center.lat.toFixed(5)}`;
  return `https://maps.geoapify.com/v1/staticmap?style=${style}&width=${w}&height=${h}&center=${c}&zoom=${z}&scaleFactor=2&apiKey=${key}`;
}

/** Free, keyless geocoding via OpenStreetMap Nominatim (usage policy: ≤1 req/s). */
export async function geocode(
  place: string,
  opts?: { countryCode?: string; viewbox?: [number, number, number, number]; bounded?: boolean },
): Promise<GeoPoint | null> {
  // Optional constraints to disambiguate a town name that matches the wrong place:
  //  - countryCode: ISO-3166-1 alpha-2 (e.g. "in").
  //  - viewbox [minLon,minLat,maxLon,maxLat] + bounded: restrict to a region box (e.g.
  //    the cluster of the OTHER stops) so "Baga" resolves to Goa, not West Bengal.
  const cc = opts?.countryCode ? `&countrycodes=${encodeURIComponent(opts.countryCode.toLowerCase())}` : '';
  const vb = opts?.viewbox
    ? `&viewbox=${opts.viewbox.map((n) => n.toFixed(4)).join(',')}${opts.bounded ? '&bounded=1' : ''}`
    : '';
  const r = await tryJson(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place)}&format=json&limit=1${cc}${vb}`,
  );
  const hit = Array.isArray(r) ? r[0] : null;
  const lat = Number(hit?.lat);
  const lon = Number(hit?.lon);
  if (!hit || Number.isNaN(lat) || Number.isNaN(lon)) return null;
  return { name: place, lat, lon };
}

/**
 * Styled route-map image URL (MapTiler Static Maps) with a marker per city and a
 * route line between them. Returns '' if no MapTiler key is set or geocoding
 * fails — the designer then falls back to a stylised AI/CSS map.
 */
export async function routeMapUrl(
  cities: string[],
  opts?: { width?: number; height?: number; color?: string },
): Promise<string> {
  const geoapify = envKey('GEOAPIFY_API_KEY');
  const maptiler = envKey('MAPTILER_API_KEY');
  if (!geoapify && !maptiler) return '';

  const pts: GeoPoint[] = [];
  for (const c of cities.slice(0, 8)) {
    const g = await geocode(c);
    if (g) pts.push(g);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // honor Nominatim 1 req/s
  }
  if (!pts.length) return '';

  const width = Math.min(opts?.width ?? 900, 2000);
  const height = Math.min(opts?.height ?? 1100, 2000);
  // Geoapify's validator requires LOWERCASE hex for marker/line colours.
  const color = (opts?.color ?? 'e4002b').replace('#', '').toLowerCase();

  // Geoapify Static Maps — FREE tier (3000/day) incl. markers + route polyline.
  // Preferred over MapTiler, whose Static Maps require a paid plan.
  if (geoapify) {
    const lons = pts.map((p) => p.lon);
    const lats = pts.map((p) => p.lat);
    const padX = (Math.max(...lons) - Math.min(...lons)) * 0.15 + 0.25;
    const padY = (Math.max(...lats) - Math.min(...lats)) * 0.15 + 0.25;
    const area = `rect:${Math.min(...lons) - padX},${Math.min(...lats) - padY},${Math.max(...lons) + padX},${Math.max(...lats) + padY}`;
    const markers = pts
      .map((p) => `lonlat:${p.lon},${p.lat};type:material;color:%23${color};size:medium`)
      .join('|');
    const geometry =
      pts.length >= 2
        ? `&geometry=polyline:${pts.map((p) => `${p.lon},${p.lat}`).join(',')};linecolor:%23${color};linewidth:4`
        : '';
    return `https://maps.geoapify.com/v1/staticmap?style=osm-bright-smooth&width=${width}&height=${height}&area=${area}&marker=${markers}${geometry}&apiKey=${geoapify}`;
  }

  // MapTiler fallback (requires a plan that includes Static Maps).
  const markers = pts.map((p) => `${p.lon},${p.lat}`).join('|');
  const path =
    pts.length >= 2
      ? `&path=stroke:0x${color}|width:4|${pts.map((p) => `${p.lon},${p.lat}`).join('|')}`
      : '';
  return `https://api.maptiler.com/maps/basic-v2/static/auto/${width}x${height}.png?key=${maptiler}&markers=${markers}${path}`;
}
