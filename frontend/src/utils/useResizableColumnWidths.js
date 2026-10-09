import { useEffect, useState } from 'react';

export default function useResizableColumnWidths(columns, storageKey) {
  const defaults = columns.map((column) => column.width);
  const [columnWidths, setColumnWidths] = useState(() => {
    if (!storageKey) return defaults;
    try {
      const saved = JSON.parse(window.localStorage.getItem(storageKey));
      return Array.isArray(saved) && saved.length === columns.length
        ? saved.map((width, index) => Math.max(columns[index].minWidth || 80, Number(width) || defaults[index]))
        : defaults;
    } catch (_error) {
      return defaults;
    }
  });

  useEffect(() => {
    if (!storageKey) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(columnWidths));
    } catch (_error) {
      // Width persistence is optional; resizing still works without storage.
    }
  }, [columnWidths, storageKey]);

  const resizeColumn = (index, width) => setColumnWidths((current) => current.map((value, columnIndex) => (
    columnIndex === index ? width : value
  )));

  return {
    columnWidths,
    resizeColumn,
    tableMinWidth: columnWidths.reduce((sum, width) => sum + width, 0),
  };
}
