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

// Best Wikipedia article title for a destination: the curated wikiTitle when
// known, else the destination cleaned to its first segment (drop ", France",
// parentheticals, trailing descriptors) so the lookup has a fighting chance.
export function wikiTitleFor(destination, theme) {
  const t = theme || destinationTheme(destination);
  if (t && t.wikiTitle) return t.wikiTitle;
  const raw = String(destination || "").trim();
  if (!raw) return null;
  const firstSegment = raw.split(/[,(–—-]/)[0].trim();
  return firstSegment || null;
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
  const title = wikiTitleFor(destination);
  if (!title || !fetchImpl) return null;
  try {
    const res = await fetchImpl(endpoint(title));
    if (!res || !res.ok) return null;
    const data = await res.json();
    const pages = data?.query?.pages;
    if (!pages) return null;
    for (const pageId of Object.keys(pages)) {
      const src = pages[pageId]?.thumbnail?.source;
      if (src) return src;
    }
    return null;
  } catch (_e) {
    return null;
  }
}

// Image files on a Wikipedia article that aren't real photos (flags, maps,
// icons, logos, SVGs) — skipped so the side rails only show actual imagery.
const SKIP_IMAGE_RE = /\.svg$|flag|map\b|locator|coat[_ ]?of[_ ]?arms|icon|logo|symbol|seal|emblem|disambig|wikimedia|commons-/i;

function galleryEndpoint(title, limit) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    redirects: "1",
    titles: title,
    generator: "images",
    gimlimit: String(limit),
    prop: "imageinfo",
    iiprop: "url|extmetadata",
    iiextmetadatafilter: "ImageDescription",
    iiurlwidth: "240",
  });
  return `https://en.wikipedia.org/w/api.php?${params.toString()}`;
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
 * Fetch a set of real destination photos (for the side rails) from the
 * Wikipedia article's images, filtered to actual raster photos. Returns an
 * array of { url, caption } (caption derived from the file name). Never throws;
 * returns [] on miss/error. `opts.limit` caps the result, `opts.fetchImpl`
 * injects a fetch stub for tests.
 */
export async function fetchDestinationGallery(destination, opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  const limit = opts.limit || 16;
  const title = wikiTitleFor(destination);
  if (!title || !fetchImpl) return [];
  try {
    const res = await fetchImpl(galleryEndpoint(title, 50));
    if (!res || !res.ok) return [];
    const data = await res.json();
    const pages = data?.query?.pages;
    if (!pages) return [];
    const out = [];
    const seen = new Set();
    for (const id of Object.keys(pages)) {
      const p = pages[id];
      const t = p?.title || "";
      if (SKIP_IMAGE_RE.test(t)) continue;
      if (!/\.(jpe?g|png)$/i.test(t)) continue;
      const u = p?.imageinfo?.[0]?.thumburl;
      if (u && !seen.has(u)) {
        seen.add(u);
        const rawDesc = p?.imageinfo?.[0]?.extmetadata?.ImageDescription?.value || "";
        // Strip HTML tags and whitespace; cap at 180 chars for the hover tooltip.
        const description = rawDesc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180) || null;
        out.push({ url: u, caption: captionFromFileTitle(t), description });
      }
      if (out.length >= limit) break;
    }
    return out;
  } catch (_e) {
    return [];
  }
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
    fetchDestinationPhoto(destination).then((url) => {
      if (alive) setPhotoUrl(url);
    });
    return () => { alive = false; };
  }, [destination]);
  return photoUrl;
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
    fetchDestinationGallery(destination).then((u) => {
      if (alive) setUrls(u);
    });
    return () => { alive = false; };
  }, [destination]);
  return urls;
}
