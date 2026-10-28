export function generatedDealName(deal) {
  const type = String(deal?.dealType || 'Deal').replace(/\s+/g, '');
  return `${type}-${deal?.id ?? ''}`;
}
