import { getAuthToken } from '../../../utils/api';

// Parse Service.imageUrls (Prisma stores a JSON-stringified array of URLs).
// `allImagesOf` returns the full array; `firstImageOf` is a convenience
// wrapper used by the card thumbnail + the inline edit-form preview.
// Tolerates both array and string-encoded shapes — older rows may carry
// either form, and a few legacy rows hold a plain non-JSON URL.
export function allImagesOf(service) {
  const raw = service?.imageUrls;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
  } catch {
    if (typeof raw === 'string' && /^https?:\/\//i.test(raw)) return [raw];
  }
  return [];
}

export function firstImageOf(service) {
  return allImagesOf(service)[0] || null;
}

// POST a file to /api/wellness/upload/service-image and return the URL.
// Mirrors the multipart pattern used by Products.jsx — same `file` field
// name, same response shape, same backend uploadImage() helper.
export async function uploadImageFile(file) {
  const token = getAuthToken();
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/wellness/upload/service-image', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Upload failed (${res.status})`);
  }
  const data = await res.json();
  return data.url;
}

export const tierColor = { high: '#ef4444', medium: '#f59e0b', low: '#64748b' };

export const TICKET_TIER_OPTIONS = [
  { value: 'low', label: 'Low tier' },
  { value: 'medium', label: 'Medium tier' },
  { value: 'high', label: 'High tier' },
];

export const statusColor = { active: '#10b981', completed: '#6366f1', paused: '#f59e0b', cancelled: '#ef4444' };

// Theme-adaptive glass backdrop so the Edit / Delete icons stay legible
// across BOTH dark and light themes, AND when they sit on top of a
// service image. --surface-hover resolves to a near-opaque tile in each
// theme (dark slate in dark mode, near-white in light mode) and
// --text-primary contrasts naturally with it.
export const iconBtn = {
  background: 'var(--surface-hover)',
  border: '1px solid var(--border-color)',
  color: 'var(--text-primary)',
  padding: '0.3rem',
  borderRadius: 6,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  backdropFilter: 'blur(4px)',
};

export const inputStyle = { padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none', width: '100%', boxSizing: 'border-box' };

export const labelStyle = {
  display: 'block',
  fontSize: '0.75rem',
  color: 'var(--text-secondary)',
  marginBottom: '0.35rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

// Visually-hidden style for screen-reader-only headings (a11y heading hierarchy).
export const srOnly = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

// ── Portal dropdown anchoring ─────────────────────────────────────
//
// Both dropdowns render their menu in a portal with `position: fixed` (to
// escape the .glass parent's backdrop-filter stacking context) and re-anchor
// it to the trigger on every scroll. That combination has a trap: a menu
// opened from a trigger near the bottom of the viewport hangs off the bottom
// edge, and scrolling the page cannot rescue it — the menu just follows its
// trigger. The options below the fold become unreachable.
//
// So the menu is measured against the room actually available. Two details
// matter for it to land where the eye expects:
//
//   - The flip decision is judged against how tall THIS menu wants to be, not
//     the 340px ceiling. A three-item list has no business jumping above the
//     trigger when 300px sit free below it.
//   - A menu that does flip up is anchored by its BOTTOM edge, so it sits
//     directly on top of the trigger. Anchoring by `top` at the ceiling height
//     left a short list floating a full menu-height above the trigger, which
//     reads as the menu opening "somewhere at the top of the page".
//
// components/MultiSelectDropdown.jsx (the one Inbox / ColumnPicker / the
// patient filters use) solves the same problem inline with its own thresholds.
// Left alone deliberately — folding the two together would change the popover
// geometry on those pages for no gain here.
export const DROPDOWN_MAX_HEIGHT = 340;

// One option row: 0.65rem padding top and bottom, ~20px of text, 1px divider.
const DROPDOWN_ROW_HEIGHT = 42;

/** Roughly how tall a menu of `rowCount` options wants to be, capped. */
export function estimateDropdownHeight(rowCount, extra = 0) {
  const rows = Math.max(1, rowCount || 1);
  return Math.min(DROPDOWN_MAX_HEIGHT, rows * DROPDOWN_ROW_HEIGHT + extra);
}

export function anchorDropdown(triggerEl, options = {}) {
  const {
    gap = 8,
    margin = 12,
    maxHeight = DROPDOWN_MAX_HEIGHT,
    minHeight = 140,
    desiredHeight = DROPDOWN_MAX_HEIGHT,
  } = options;
  const r = triggerEl.getBoundingClientRect();
  const viewportH = window.innerHeight || 0;
  const spaceBelow = Math.round(viewportH - r.bottom - gap - margin);
  const spaceAbove = Math.round(r.top - gap - margin);
  const wanted = Math.min(maxHeight, Math.max(1, Math.round(desiredHeight)));

  // Flip up only when the menu genuinely does not fit below AND there is more
  // room above.
  const openUp = spaceBelow < Math.min(wanted, spaceAbove) && spaceAbove > spaceBelow;

  if (openUp) {
    return {
      openUp: true,
      bottom: viewportH - r.top + gap,
      left: r.left,
      width: r.width,
      maxHeight: Math.min(wanted, Math.max(0, spaceAbove)),
    };
  }

  // The min-height floor keeps a squeezed menu usable; the clamp then keeps it
  // on screen even when that floor is more than the space below allows.
  const height = Math.min(wanted, Math.max(minHeight, spaceBelow));
  const top = Math.max(margin, Math.min(r.bottom + gap, viewportH - margin - height));
  return { openUp: false, top, left: r.left, width: r.width, maxHeight: height };
}
