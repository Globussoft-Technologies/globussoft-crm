// Small RFC 4180-compatible parser for browser-side import previews. Handles
// quoted commas, escaped quotes, CRLF/LF, and embedded newlines.
export function parseCsvRows(input) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const text = String(input || '').replace(/^\uFEFF/, '');

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  row.push(field);
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
}
