// Keyless destination photos via the Wikipedia API.
//
// The Wikipedia action API is CORS-enabled (with origin=*) and needs no key,
// so it works from the customer's browser on the public pages. We ask for the
// destination article's lead image at a hero-friendly width (pithumbsize) and
// follow redirects (Banaras → Varanasi, etc.). Quality is "the article's lead
// photo" — usually a good city/landmark shot, occasionally plain — and we
// always fall back to the themed gradient when there's no usable image.
//
// Pure fetcher (`fetchDestinationPhoto`) + a React hook (`useDestinationPhoto`).

import { useEffect, useState } from "react";
import { destinationTheme } from "./destinationTheme";

// ── Server-side Pexels proxy (primary source) ──────────────────────────────
//
// The keyless Wikipedia path below stays as a fallback, but the PRIMARY source
// is now our backend proxy GET /api/travel/destination-photos/public, which
// calls Pexels with a server-held key and a shared 24h cache. That removes the
// "images vanish again and again" flicker — Wikipedia rate-limits anonymous
// API traffic and the client did no caching, so the hero (action API) and the
// side rails (REST media-list API) would intermittently come back empty.
//
// We also add a small client-side cache so a destination isn't re-fetched on
// every component remount within a session.
const PROXY_ENDPOINT = "/api/travel/destination-photos/public";
const _proxyCache = new Map(); // `${q}::${limit}` → Promise<Photo[]>

/**
 * Fetch destination photos from our backend Pexels proxy. Returns an array of
 * { url, caption, description } (possibly empty). Never throws — resolves to []
 * on any failure so callers fall back to Wikipedia. `opts.fetchImpl` injects a
 * stub for tests; when omitted in a non-browser/test env it no-ops to [].
 */
export async function fetchProxyPhotos(destination, opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  const q = String(destination || "").trim();
  const limit = opts.limit || 12;
  if (!q || !fetchImpl) return [];
  const key = `${q.toLowerCase()}::${limit}`;
  if (_proxyCache.has(key)) return _proxyCache.get(key);
  const p = (async () => {
    try {
      const res = await fetchImpl(
        `${PROXY_ENDPOINT}?q=${encodeURIComponent(q)}&limit=${limit}`,
      );
      if (!res || !res.ok) return [];
      const data = await res.json();
      const photos = Array.isArray(data && data.photos) ? data.photos : [];
      return photos
        .map((x) => ({
          url: x.url,
          caption: x.caption || q,
          description: x.description || null,
        }))
        .filter((x) => x.url);
    } catch (_e) {
      return [];
    }
  })();
  // Cache the in-flight promise; evict on empty resolution so a transient miss
  // doesn't pin "no photos" for the session (a later mount can retry).
  _proxyCache.set(key, p);
  p.then((arr) => {
    if (!arr.length) _proxyCache.delete(key);
  });
  return p;
}

// Best Wikipedia article title for a destination: the curated wikiTitle when
// known, else the destination cleaned to its first segment (drop ", France",
// parentheticals, trailing descriptors) so the lookup has a fighting chance.
export function wikiTitleFor(destination, theme) {
  const t = theme || destinationTheme(destination);
  if (t && t.wikiTitle) return t.wikiTitle;
  const raw = String(destination || "").trim();
  if (!raw) return null;
  const firstSegment = raw.split(/[,(–—·-]/)[0].trim();
  return firstSegment || null;
}

// Ordered list of Wikipedia article titles to try for a destination, from most
// to least specific. The first title that yields an image wins. This makes
// landmark-style destinations ("Iskon Bangalore", "ISKCON Temple Mumbai")
// resolve to a real photo: the full phrase has no Wikipedia article, but the
// trailing city word ("Bangalore" → "Bengaluru") does. Single-word
// destinations ("Tokyo", "Goa") produce exactly one candidate, so their
// behaviour is unchanged.
export function wikiTitleCandidates(destination) {
  const out = [];
  const push = (v) => {
    const s = String(v || "").trim();
    if (s && !out.includes(s)) out.push(s);
  };
  const t = destinationTheme(destination);
  if (t && t.wikiTitle) push(t.wikiTitle);
  const raw = String(destination || "").trim();
  if (raw) {
    const firstSegment = raw.split(/[,(–—·-]/)[0].trim();
    push(firstSegment);
    // Landmark + city phrase: the last word is usually the city, which
    // Wikipedia resolves even when the full landmark name doesn't.
    const words = firstSegment.split(/\s+/).filter(Boolean);
    if (words.length > 1) push(words[words.length - 1]);
  }
  return out;
}

function endpoint(title) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    prop: "pageimages",
    piprop: "thumbnail",
    pithumbsize: "1280",
    redirects: "1",
    titles: title,
    origin: "*",
  });
  return `https://en.wikipedia.org/w/api.php?${params.toString()}`;
}

/**
 * Resolve a destination to a real photo URL (or null). Never throws.
 * `opts.fetchImpl` lets tests inject a fetch stub.
 */
export async function fetchDestinationPhoto(destination, opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  const titles = wikiTitleCandidates(destination);
  if (!titles.length || !fetchImpl) return null;
  // Try each candidate (specific → city) until one yields a lead image.
  for (const title of titles) {
    try {
      const res = await fetchImpl(endpoint(title));
      if (!res || !res.ok) continue;
      const data = await res.json();
      const pages = data?.query?.pages;
      if (!pages) continue;
      for (const pageId of Object.keys(pages)) {
        const src = pages[pageId]?.thumbnail?.source;
        if (src) return src;
      }
    } catch (_e) {
      // try the next candidate
    }
  }
  return null;
}

// Turn a Wikipedia file title ("File:Tokyo Tower at night.jpg") into a short
// human caption ("Tokyo Tower at night").
export function captionFromFileTitle(fileTitle) {
  return String(fileTitle || "")
    .replace(/^File:/i, "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetch a set of real destination photos via the Wikipedia REST API media-list
 * endpoint. This correctly resolves Wikimedia Commons files (which the older
 * action-API generator=images approach could not — Commons files appear as
 * "missing" in en.wikipedia, so imageinfo returned nothing). The REST endpoint
 * returns pre-computed thumbnail URLs and a showInGallery flag that
 * Wikipedia editors set to distinguish real photos from maps/icons/flags.
 *
 * Returns an array of { url, caption } (up to `opts.limit`). Never throws;
 * returns [] on miss/error. `opts.fetchImpl` injects a fetch stub for tests.
 */
export async function fetchDestinationGallery(destination, opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  const limit = opts.limit || 16;
  const titles = wikiTitleCandidates(destination);
  if (!titles.length || !fetchImpl) return [];
  for (const title of titles) {
    try {
      const url = `https://en.wikipedia.org/api/rest_v1/page/media-list/${encodeURIComponent(title)}`;
      const res = await fetchImpl(url);
      if (!res || !res.ok) continue;
      const data = await res.json();
      const items = Array.isArray(data?.items) ? data.items : [];
      const out = [];
      for (const item of items) {
        if (item.type !== "image" || !item.showInGallery) continue;
        const src = item.thumbnail?.source;
        if (!src) continue;
        const photoUrl = src.startsWith("//") ? `https:${src}` : src;
        const caption = item.caption?.text || captionFromFileTitle(item.title || "");
        out.push({ url: photoUrl, caption, description: null });
        if (out.length >= limit) break;
      }
      if (out.length) return out;
    } catch (_e) {
      // try the next candidate
    }
  }
  return [];
}

/**
 * Hook: returns the destination's photo URL once fetched (null until then /
 * on miss). Re-runs when the destination changes; ignores stale responses.
 */
export function useDestinationPhoto(destination) {
  const [photoUrl, setPhotoUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    setPhotoUrl(null);
    if (!destination) return undefined;
    // Pexels proxy first (1 landscape shot for the hero); fall back to the
    // keyless Wikipedia lead image if the proxy has no key / misses.
    fetchProxyPhotos(destination, { limit: 1 })
      .then((arr) => {
        if (arr.length && arr[0].url) return arr[0].url;
        return fetchDestinationPhoto(destination);
      })
      .then((url) => {
        if (alive) setPhotoUrl(url || null);
      });
    return () => { alive = false; };
  }, [destination]);
  return photoUrl;
}

/**
 * Hook: gallery photos spanning MULTIPLE destinations (for a multi-city trip's
 * side rails). Fetches each city's gallery (capped) and INTERLEAVES the results
 * so the rails alternate cities (Makkah, Paris, Madinah, France, …) instead of
 * showing only the first city. Empty until fetched / on miss; ignores stale
 * responses. Pass [] / a single-element array to effectively no-op.
 */
export function useMultiDestinationGallery(destinations) {
  const [urls, setUrls] = useState([]);
  // Stable dependency key — the array identity changes every render otherwise.
  const key = (destinations || []).filter(Boolean).join("|");
  useEffect(() => {
    let alive = true;
    setUrls([]);
    const list = (destinations || []).filter(Boolean).slice(0, 6);
    if (!list.length) return undefined;
    Promise.all(
      list.map((d) =>
        // Pexels proxy first per city; Wikipedia REST fallback on a miss.
        fetchProxyPhotos(d, { limit: 4 })
          .then((g) => (g.length ? g : fetchDestinationGallery(d, { limit: 4 })))
          .then((g) => g.map((x) => ({ ...x, city: d })))
          .catch(() => []),
      ),
    ).then((perCity) => {
      if (!alive) return;
      const out = [];
      const max = Math.max(0, ...perCity.map((p) => p.length));
      for (let i = 0; i < max; i += 1) {
        for (const p of perCity) if (p[i]) out.push(p[i]);
      }
      setUrls(out);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return urls;
}

/**
 * Hook: returns an array of destination photo URLs (for the side rails).
 * Empty until fetched / on miss. Ignores stale responses.
 */
export function useDestinationGallery(destination) {
  const [urls, setUrls] = useState([]);
  useEffect(() => {
    let alive = true;
    setUrls([]);
    if (!destination) return undefined;
    // Pexels proxy first (a set of landscape shots for the side rails); fall
    // back to the keyless Wikipedia REST media-list if the proxy misses.
    fetchProxyPhotos(destination, { limit: 16 })
      .then((arr) => (arr.length ? arr : fetchDestinationGallery(destination)))
      .then((u) => {
        if (alive) setUrls(u);
      });
    return () => { alive = false; };
  }, [destination]);
  return urls;
}
