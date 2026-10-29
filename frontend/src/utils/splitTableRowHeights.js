// Table-cell heights are minimums, not caps. Frozen and scrolling tables
// must share each row's natural height, including multi-line contact names.
export function syncSplitTableRowHeights(frozenTable, scrollableTable) {
  if (!frozenTable || !scrollableTable) return;
  const frozenRows = [...frozenTable.querySelectorAll('thead tr, tbody tr')];
  const scrollableRows = [...scrollableTable.querySelectorAll('thead tr, tbody tr')];
  if (frozenRows.length !== scrollableRows.length) return;

  // Clear the previous measurements first so rows can shrink after an edit
  // or viewport change. Batch reads before writes to avoid layout thrashing.
  for (const row of [...frozenRows, ...scrollableRows]) row.style.height = '';
  const heights = frozenRows.map((row, index) => Math.ceil(Math.max(
    row.getBoundingClientRect().height,
    scrollableRows[index].getBoundingClientRect().height,
  )));
  heights.forEach((height, index) => {
    frozenRows[index].style.height = `${height}px`;
    scrollableRows[index].style.height = `${height}px`;
  });
}

export function observeSplitTableRowHeights(frozenTable, scrollableTable) {
  if (!frozenTable || !scrollableTable) return () => {};
  let frame = null;
  const schedule = () => {
    if (frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      syncSplitTableRowHeights(frozenTable, scrollableTable);
    });
  };
  syncSplitTableRowHeights(frozenTable, scrollableTable);
  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  resizeObserver?.observe(frozenTable);
  resizeObserver?.observe(scrollableTable);
  // An editor closing can shrink content without changing the table's old,
  // explicitly synchronized height. Watch content, but not our style writes.
  const mutationObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule);
  for (const table of [frozenTable, scrollableTable]) {
    mutationObserver?.observe(table, { subtree: true, childList: true, characterData: true });
  }
  window.addEventListener('resize', schedule);
  return () => {
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    window.removeEventListener('resize', schedule);
    if (frame !== null) window.cancelAnimationFrame(frame);
    for (const table of [frozenTable, scrollableTable]) {
      table.querySelectorAll('thead tr, tbody tr').forEach(row => { row.style.height = ''; });
    }
  };
}
