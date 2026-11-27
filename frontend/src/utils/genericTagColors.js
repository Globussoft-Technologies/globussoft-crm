export const GENERIC_TAG_COLORS = [
  '#2563eb',
  '#7c3aed',
  '#0891b2',
  '#059669',
  '#d97706',
  '#db2777',
  '#dc2626',
];

export function fallbackTagColor(name) {
  let hash = 0;
  for (const character of String(name || '')) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  }
  return GENERIC_TAG_COLORS[Math.abs(hash) % GENERIC_TAG_COLORS.length];
}

export function tagTextColor(color) {
  const hex = String(color || '').replace('#', '');
  if (hex.length !== 6) return '#fff';
  const [red, green, blue] = [0, 2, 4].map((offset) =>
    parseInt(hex.slice(offset, offset + 2), 16),
  );
  return (red * 299 + green * 587 + blue * 114) / 1000 > 155
    ? '#0f172a'
    : '#fff';
}
