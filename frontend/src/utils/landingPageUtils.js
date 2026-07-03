/**
 * landingPageUtils.js — Shared utilities for React landing page rendering.
 * Mirrors backend/services/landingPageRenderer.js logic for client-side use.
 */

/**
 * Safely validate and normalize URLs based on context (image, link, iframe).
 * Implements the same allowlist as the backend renderer (#447).
 */
const SAFE_FALLBACK = {
  'image-src': '',
  'link-href': '#',
  'iframe-src': 'about:blank',
};

export function safeUrl(input, kind) {
  if (input == null) return SAFE_FALLBACK[kind] ?? '';
  const raw = String(input);
  // Browsers strip leading C0 whitespace AND TAB before scheme parsing
  const trimmed = raw.replace(/^[\s\x00-\x1f]+/, '');
  // Empty / whitespace-only input
  if (trimmed.length === 0) return SAFE_FALLBACK[kind] ?? '';
  const lower = trimmed.toLowerCase();
  // Allow same-page anchor, relative path, protocol-relative
  if (lower.startsWith('#') || lower.startsWith('/')) return trimmed;
  // Scheme-prefixed values
  const schemeMatch = lower.match(/^([a-z][a-z0-9+.-]*):/);
  if (!schemeMatch) return trimmed; // No scheme, treat as relative

  const scheme = schemeMatch[1];
  if (kind === 'image-src') {
    if (scheme === 'http' || scheme === 'https') return trimmed;
    if (scheme === 'data' && /^data:image\//i.test(trimmed)) return trimmed;
    return SAFE_FALLBACK['image-src'];
  }
  if (kind === 'link-href') {
    if (scheme === 'http' || scheme === 'https') return trimmed;
    if (scheme === 'mailto' || scheme === 'tel' || scheme === 'sms') return trimmed;
    return SAFE_FALLBACK['link-href'];
  }
  if (kind === 'iframe-src') {
    if (scheme === 'http' || scheme === 'https') return trimmed;
    return SAFE_FALLBACK['iframe-src'];
  }
  return SAFE_FALLBACK[kind] ?? '';
}

/**
 * HTML escape for text content. Matches backend escapeHtml.
 */
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render a pricing cell. Mirrors backend renderPricingValue.
 */
export function renderPricingValue(amount, currency) {
  if (amount == null || amount === "") {
    return { __html: '<div class="t-tier-amount t-tier-amount--empty" aria-label="Pricing to be configured">Pricing TBD</div>' };
  }
  const sym = escapeHtml(currency || "₹");
  return escapeHtml(`${sym}${String(amount)}`);
}

/**
 * Validate and normalize a video embed URL.
 * Used by the video block component.
 */
export function normalizeVideoEmbedUrl(url) {
  if (!url) return '';

  // YouTube: watch -> /embed, Shorts, youtu.be
  if (url.includes('youtube.com/watch') || url.includes('youtu.be')) {
    const id = url.match(/(?:youtu\.be\/|youtube\.com\/watch\?v=)([^&]+)/)?.[1];
    return id ? `https://www.youtube.com/embed/${id}` : url;
  }

  // Vimeo
  if (url.includes('vimeo.com')) {
    const id = url.match(/vimeo\.com\/(\d+)/)?.[1];
    return id ? `https://player.vimeo.com/video/${id}` : url;
  }

  return url;
}

/**
 * Check if a URL is a direct video file (mp4, webm, etc.)
 */
export function isDirectVideoFile(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return /\.(mp4|webm|ogg|mov)(\?|$)/i.test(lower) ||
         /\/api\/.*\.(mp4|webm|ogg|mov)/i.test(lower);
}

/**
 * Determine the correct renderer based on landing page template type.
 */
export function getRendererType(landingPage) {
  if (!landingPage) return 'block-array'; // default

  const templateType = landingPage.templateType;
  if (!templateType) return 'block-array';

  if (templateType === 'wanderlux-v1') return 'wanderlux';
  if (templateType === 'educational-trip-v1') return 'educational';
  if (templateType === 'religious-tour-v1') return 'religious';
  if (templateType === 'family-trip-v1') return 'family';
  if (templateType === 'luxury-tour-v1') return 'luxury';
  if (templateType === 'travel-premium-v1') return 'travel-premium';

  // Fallback for travel_destination and other block-array pages
  return 'block-array';
}

/**
 * Parse landing page content JSON based on type.
 */
export function parseContentJson(landingPage) {
  if (!landingPage || !landingPage.content) return null;

  try {
    if (typeof landingPage.content === 'string') {
      return JSON.parse(landingPage.content);
    }
    return landingPage.content;
  } catch (e) {
    console.error('Failed to parse landing page content:', e);
    return null;
  }
}

/**
 * Format currency display.
 */
export function formatCurrency(amount, currency = '₹') {
  if (amount == null || amount === '') return null;
  return `${currency}${amount}`;
}
