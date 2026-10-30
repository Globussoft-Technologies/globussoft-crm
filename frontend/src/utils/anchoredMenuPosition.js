// Fixed-position menus rendered into document.body must fit the viewport,
// independently of the anchor's scroll/clipping ancestors.
export function anchoredMenuPosition(rect, viewportWidth, viewportHeight) {
  const margin = 8;
  const gap = 6;
  const width = Math.max(0, Math.min(264, viewportWidth - margin * 2));
  const below = Math.max(0, viewportHeight - rect.bottom - gap - margin);
  const above = Math.max(0, rect.top - gap - margin);
  const openUp = below < Math.min(420, above);
  return {
    position: 'fixed',
    boxSizing: 'border-box',
    width,
    left: Math.max(margin, Math.min(rect.right - width, viewportWidth - margin - width)),
    top: openUp ? 'auto' : Math.max(margin, rect.bottom + gap),
    bottom: openUp ? Math.max(margin, viewportHeight - rect.top + gap) : 'auto',
    maxHeight: Math.min(420, openUp ? above : below),
    zIndex: 20000,
  };
}
