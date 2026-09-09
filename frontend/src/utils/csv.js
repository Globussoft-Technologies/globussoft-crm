/**
 * Parse an RFC 4180-style CSV string into a header array and cell arrays.
 * Supports UTF-8 BOMs, CRLF/LF/CR records, escaped quotes, embedded commas,
 * and embedded newlines inside quoted fields.
 */
export function parseCsvTable(input) {
  if (typeof input !== 'string') throw new TypeError('parseCsvTable expects a string');
  const text = input.charCodeAt(0) === 0xFEFF ? input.slice(1) : input;
  if (!text) return { headers: [], records: [] };

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const pushRow = () => {
    row.push(field);
    if (row.some((cell) => String(cell).trim() !== '')) rows.push(row);
    row = [];
    field = '';
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field.length === 0) {
      inQuotes = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\r' || character === '\n') {
      pushRow();
      if (character === '\r' && text[index + 1] === '\n') index += 1;
    } else {
      field += character;
    }
  }

  if (field.length > 0 || row.length > 0) pushRow();
  if (rows.length === 0) return { headers: [], records: [] };

  const headers = rows[0].map((header) => String(header).trim().toLowerCase());
  return { headers, records: rows.slice(1) };
}
