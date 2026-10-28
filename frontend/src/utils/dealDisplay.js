export function generatedDealName(deal) {
  // Preserve an explicit business title. Generated names are only the
  // fallback for records that do not have a title (or still use the legacy
  // "<contact> Deal" placeholder).
  const title = String(deal?.title || '').trim();
  const relatedNames = [
    deal?.contactName,
    deal?.contact?.name,
  ].filter(Boolean).map((value) => String(value).trim().toLowerCase());
  const isLegacyPlaceholder = title.toLowerCase().endsWith(' deal')
    && relatedNames.includes(title.slice(0, -5).trim().toLowerCase());
  if (title && !isLegacyPlaceholder) return title;
  const type = String(deal?.dealType || 'Deal').replace(/\s+/g, '');
  return `${type}-${deal?.id ?? ''}`;
}
