import React from 'react';

/**
 * frontend/src/components/Avatar.jsx
 *
 * Issues #637 / #642 — Identity at-a-glance.
 *
 * Renders a circular avatar with the user's initials on a deterministic
 * background colour (hash of the name → fixed palette of 8 swatches). The
 * same name always picks the same swatch, so a user keeps a stable colour
 * across pages and sessions.
 *
 * Optional `roleBadge` prop renders a tiny corner pip with the role's first
 * letter — used by the app header so signed-in users can tell at a glance
 * whether they're Owner / Admin / Manager / User. The pip is purely visual;
 * the canonical role lives on user.role and is enforced server-side.
 *
 * Theme awareness — the palette swatches are picked to read on BOTH the
 * generic dark surface and the wellness cream/teal surface. Pure red /
 * pure orange clash with the wellness blush; the palette skews to cool
 * neutrals + a couple of warm earth tones so neither vertical looks off.
 */

// 8-swatch palette — readable on light + dark surfaces, neutral enough
// to coexist with the wellness blush/teal and the generic blue accent.
const PALETTE = [
  '#5b8def', // soft blue
  '#8b6fbf', // muted purple
  '#3b9d96', // teal (matches wellness primary family)
  '#d68a5e', // warm earth (matches wellness blush family)
  '#6f9a4d', // sage green
  '#c97a8e', // dusty rose
  '#7b8794', // slate grey
  '#b3884a', // burnished gold
];

// Role → badge colour. ADMIN/OWNER get the warmest treatment so the
// signed-in operator sees their elevated status; USER gets a neutral grey
// so the badge doesn't visually compete with the avatar swatch.
//
// #706: ADMIN used to render in `#dc2626` red. Combined with the small
// pip size + corner position, the red dot read as an "unread notification"
// indicator — operators clicked the avatar expecting an actionable item.
// Switched to a deep amber `#92400e` that reads as a role badge, not an
// alarm. The Avatar always renders `title=` + `aria-label` so the
// hover/SR experience explains the badge unambiguously.
const ROLE_COLORS = {
  OWNER:   '#d4a017', // gold
  ADMIN:   '#92400e', // deep amber — formerly red, see #706
  MANAGER: '#2563eb', // blue
  USER:    '#6b7280', // grey
};

// Stable string hash → palette index. Tiny FNV-ish loop, deterministic
// across renders and across machines. Avoids importing a hash lib.
function hashIndex(str, mod) {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % mod;
}

// First-letter-first-name + first-letter-last-name. Falls back to the
// first character of whatever's available, then '?'.
export function getInitials(name) {
  if (!name || typeof name !== 'string') return '?';
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

export function getColorFromName(name) {
  if (!name || typeof name !== 'string') return PALETTE[0];
  return PALETTE[hashIndex(name, PALETTE.length)];
}

const Avatar = ({
  name,
  size = 32,
  color,
  roleBadge,
  title,
}) => {
  const safeName = (name || '').toString();
  const initials = getInitials(safeName);
  const bg = color || getColorFromName(safeName);
  // Pip ~= 38% of the avatar, capped so it stays legible on small avatars.
  const pipSize = Math.max(12, Math.round(size * 0.38));
  const pipFontSize = Math.max(8, Math.round(pipSize * 0.55));
  const roleKey = (roleBadge || '').toString().toUpperCase();
  const pipColor = ROLE_COLORS[roleKey] || ROLE_COLORS.USER;
  const pipLetter = roleKey ? roleKey.charAt(0) : '';

  return (
    <span
      data-testid="avatar"
      data-avatar-name={safeName || undefined}
      data-avatar-role={roleKey || undefined}
      title={title || (roleBadge ? `${safeName || 'User'} · ${roleBadge}` : safeName || undefined)}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: '50%',
        background: bg,
        color: '#fff',
        fontSize: Math.max(10, Math.round(size * 0.4)),
        fontWeight: 600,
        lineHeight: 1,
        userSelect: 'none',
        flexShrink: 0,
      }}
    >
      <span aria-hidden="true">{initials}</span>
      {roleBadge ? (
        <span
          data-testid="avatar-role-badge"
          aria-label={`Role: ${roleBadge}`}
          style={{
            position: 'absolute',
            right: -2,
            bottom: -2,
            width: pipSize,
            height: pipSize,
            borderRadius: '50%',
            background: pipColor,
            color: '#fff',
            fontSize: pipFontSize,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 0 2px var(--surface-color, #fff)',
            lineHeight: 1,
          }}
        >
          {pipLetter}
        </span>
      ) : null}
    </span>
  );
};

export default Avatar;
