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
 * Confirm a candidate URL actually serves a real image.
 *
 * The keyless sources (Openverse, Wikimedia) regularly hand back URLs that
 * 404, redirect to an HTML interstitial, or block hotlinking — the image then
 * silently renders as a blank/grey box. That is not just cosmetic: the print
 * preflight (`auditPrintLayout`) rejects a whole design if ANY image fails to
 * load, so a single dead URL made every AI-composed attempt fail and forced
 * the plain deterministic fallback template. Verifying here means only
 * loadable photos ever reach the designer.
 */
async function imageLoads(url: string): Promise<boolean> {
  const ok = (res: Response) =>
    res.ok && (res.headers.get('content-type') || '').toLowerCase().startsWith('image/');
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': UA, Accept: 'image/*' },
    });
    if (ok(head)) return true;
    // Some CDNs don't implement HEAD (405) — retry with a 1-byte ranged GET
    // rather than writing the photo off as broken.
    if (head.status !== 405 && head.status !== 403 && head.status !== 501) return false;
  } catch {
    /* fall through to the ranged GET below */
  }
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': UA, Accept: 'image/*', Range: 'bytes=0-0' },
    });
    try { await res.body?.cancel(); } catch { /* best-effort */ }
    return ok(res) || (res.status === 206 && (res.headers.get('content-type') || '').toLowerCase().startsWith('image/'));
  } catch {
    return false;
  }
}

/** Drop every candidate that doesn't actually serve an image (checked in parallel). */
async function keepLoadable(photos: PhotoResult[]): Promise<PhotoResult[]> {
  if (!photos.length) return photos;
  const verdicts = await Promise.all(photos.map((p) => imageLoads(p.url)));
  return photos.filter((_, i) => verdicts[i]);
}

/**
 * Real photo search with a graceful free-source fallback chain:
 * Pexels (key) -> Unsplash (key) -> Openverse (keyless) -> Wikimedia (keyless).
 * Returns direct image URLs suitable for an <img src>, every one of them
 * verified to actually load (see imageLoads above).
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
    const live = await keepLoadable(out);
    if (live.length) return live.slice(0, n);
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
    const live = await keepLoadable(out);
    if (live.length) return live.slice(0, n);
  }

  // 3) Openverse — keyless, commercially-licensed CC media.
  const ov = await tryJson(
    `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=${n}&license_type=commercial&mature=false`,
  );
  const ovOut = ((ov?.results as any[]) ?? [])
    .map((p) => ({ url: p?.url, source: 'openverse', alt: p?.title }))
    .filter((p) => p.url);
  const ovLive = await keepLoadable(ovOut);
  if (ovLive.length) return ovLive.slice(0, n);

  // 4) Wikimedia Commons — keyless, great for named landmarks.
  return keepLoadable(await wikimediaSearch(q, n));
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
  opts?: { width?: number; height?: number; color?: string; countryHint?: string },
): Promise<string> {
  const geoapify = envKey('GEOAPIFY_API_KEY');
  const maptiler = envKey('MAPTILER_API_KEY');
  if (!geoapify && !maptiler) return '';

  // Bare city names (or a garbled/placeholder entry that slipped through
  // upstream) can otherwise geocode to a same-named place anywhere in the
  // world — appending the trip's own destination country to the query
  // string biases Nominatim toward the right part of the world instead of a
  // wrong-country false match, and makes an unresolvable placeholder just
  // fail to geocode (silently skipped below) rather than land somewhere odd.
  const country = (opts?.countryHint || '').trim();
  const pts: GeoPoint[] = [];
  for (const c of cities.slice(0, 8)) {
    const g = await geocode(country ? `${c}, ${country}` : c);
    if (g) pts.push(g);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // honor Nominatim 1 req/s
  }
  if (!pts.length) return '';

  const width = Math.min(opts?.width ?? 900, 2000);
  const height = Math.min(opts?.height ?? 1100, 2000);
  // Geoapify's validator requires LOWERCASE hex for marker/line colours.
  const color = (opts?.color ?? 'e4002b').replace('#', '').toLowerCase();

  const markers = pts
    .map((p) => `lonlat:${p.lon},${p.lat};type:material;color:%23${color};size:medium`)
    .join('|');

  // Geoapify Static Maps — FREE tier (3000/day) incl. markers + route polyline.
  // Preferred over MapTiler, whose Static Maps require a paid plan.
  if (geoapify) {
    let areaOrCenter: string;
    if (pts.length === 1) {
      // The multi-point bounding-box padding formula below degenerates for a
      // single point (zero-width box + a fixed 0.25° pad = the ENTIRE visible
      // area), which rendered a whole state/region around one pin instead of
      // a usable city-level view for any single-destination trip. A lone
      // point has no bounds to fit — use an explicit close-in city zoom instead.
      areaOrCenter = `center=lonlat:${pts[0]!.lon},${pts[0]!.lat}&zoom=11.5`;
    } else {
      const lons = pts.map((p) => p.lon);
      const lats = pts.map((p) => p.lat);
      const padX = (Math.max(...lons) - Math.min(...lons)) * 0.15 + 0.25;
      const padY = (Math.max(...lats) - Math.min(...lats)) * 0.15 + 0.25;
      areaOrCenter = `area=rect:${Math.min(...lons) - padX},${Math.min(...lats) - padY},${Math.max(...lons) + padX},${Math.max(...lats) + padY}`;
    }
    const geometry =
      pts.length >= 2
        ? `&geometry=polyline:${pts.map((p) => `${p.lon},${p.lat}`).join(',')};linecolor:%23${color};linewidth:4`
        : '';
    return `https://maps.geoapify.com/v1/staticmap?style=osm-bright-smooth&width=${width}&height=${height}&${areaOrCenter}&marker=${markers}${geometry}&apiKey=${geoapify}`;
  }

  // MapTiler fallback (requires a plan that includes Static Maps).
  const markerParam = pts.map((p) => `${p.lon},${p.lat}`).join('|');
  const path =
    pts.length >= 2
      ? `&path=stroke:0x${color}|width:4|${pts.map((p) => `${p.lon},${p.lat}`).join('|')}`
      : '';
  const centerParam = pts.length === 1 ? `${pts[0]!.lon},${pts[0]!.lat},11.5` : 'auto';
  return `https://api.maptiler.com/maps/basic-v2/static/${centerParam}/${width}x${height}.png?key=${maptiler}&markers=${markerParam}${path}`;
}
