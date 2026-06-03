import { getAuthToken } from '../../utils/api';

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
