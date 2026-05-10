// @ts-check
/**
 * Wave 7 Agent A — vitest unit suite for backend/lib/csvHelpers.js.
 *
 * The lib hosts six pure helpers that the new export/import surfaces
 * (services / products / memberships / bookings) call:
 *
 *   • escapeCell                 — RFC4180 quoting (commas, quotes, CR, LF)
 *   • sanitizeCellForExport      — formula-injection prefix-quote (CVE-class)
 *   • serializeRows              — multi-row table → CSV string with UTF-8 BOM
 *   • parseCsv                   — single-pass RFC4180 parser
 *   • buildErrorReport           — per-row error report builder
 *   • setCsvDownloadHeaders      — Content-Type + Content-Disposition setter
 *
 * No prisma / network mocks needed — every helper is pure (input → output)
 * except setCsvDownloadHeaders which takes an Express-shaped res mock.
 *
 * Branch coverage targets:
 *   • escapeCell: null/undefined → '', plain → as-is, comma → quoted,
 *     newline → quoted, internal-quote → doubled, number/bool coercion
 *   • sanitizeCellForExport: =-prefix, +-prefix, --prefix, @-prefix, tab,
 *     CR-prefix, plain → no-op, non-string → no-op, empty → no-op
 *   • serializeRows: BOM present, header row, body rendering with optional
 *     render fn, formula-injection prefix on body cells, CRLF line endings
 *   • parseCsv: BOM strip, simple rows, quoted commas, escaped quotes,
 *     CRLF + LF + CR line endings, trailing empty rows trimmed, missing-
 *     column row gets undefined
 *   • buildErrorReport: shape matches { rowNumber, reason } columns
 *   • setCsvDownloadHeaders: writes both headers
 *
 * Pattern: pure-function suite (no mocks). Mirrors lib/walletCodes.test.js +
 * lib/sanitizeJson.test.js layout.
 */

import { describe, it, expect } from "vitest";
import {
  escapeCell,
  sanitizeCellForExport,
  serializeRows,
  parseCsv,
  buildErrorReport,
  setCsvDownloadHeaders,
  UTF8_BOM,
} from "../../lib/csvHelpers.js";

describe("csvHelpers — escapeCell", () => {
  it("renders null/undefined as empty string", () => {
    expect(escapeCell(null)).toBe("");
    expect(escapeCell(undefined)).toBe("");
  });
  it("returns simple text unmodified", () => {
    expect(escapeCell("hello")).toBe("hello");
    expect(escapeCell("paracetamol")).toBe("paracetamol");
  });
  it("quotes cells containing a comma", () => {
    expect(escapeCell("a, b")).toBe('"a, b"');
  });
  it("quotes + doubles internal quotes", () => {
    expect(escapeCell('say "hi"')).toBe('"say ""hi"""');
  });
  it("quotes cells with CR or LF", () => {
    expect(escapeCell("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCell("line1\rline2")).toBe('"line1\rline2"');
    expect(escapeCell("line1\r\nline2")).toBe('"line1\r\nline2"');
  });
  it("coerces numbers + booleans", () => {
    expect(escapeCell(42)).toBe("42");
    expect(escapeCell(0)).toBe("0");
    expect(escapeCell(true)).toBe("true");
    expect(escapeCell(false)).toBe("false");
  });
});

describe("csvHelpers — sanitizeCellForExport", () => {
  it("prefixes single-quote on =-prefixed strings", () => {
    expect(sanitizeCellForExport("=SUM(A1:A10)")).toBe("'=SUM(A1:A10)");
  });
  it("prefixes on +/-/@/tab/CR", () => {
    expect(sanitizeCellForExport("+1")).toBe("'+1");
    expect(sanitizeCellForExport("-100")).toBe("'-100");
    expect(sanitizeCellForExport("@admin")).toBe("'@admin");
    expect(sanitizeCellForExport("\tdata")).toBe("'\tdata");
    expect(sanitizeCellForExport("\rdata")).toBe("'\rdata");
  });
  it("leaves safe strings unmodified", () => {
    expect(sanitizeCellForExport("Acne consult")).toBe("Acne consult");
    expect(sanitizeCellForExport("100mg paracetamol")).toBe("100mg paracetamol");
  });
  it("no-op on non-strings", () => {
    expect(sanitizeCellForExport(42)).toBe(42);
    expect(sanitizeCellForExport(null)).toBe(null);
    expect(sanitizeCellForExport(undefined)).toBe(undefined);
  });
  it("no-op on empty string", () => {
    expect(sanitizeCellForExport("")).toBe("");
  });
});

describe("csvHelpers — serializeRows", () => {
  it("emits a BOM-prefixed CSV with header + rows", () => {
    const csv = serializeRows(
      [
        { key: "name", header: "Name" },
        { key: "price", header: "Price" },
      ],
      [
        { name: "Acne consult", price: 1500 },
        { name: "Hair, deluxe", price: 5000 },
      ],
    );
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    expect(csv).toContain("Name,Price");
    expect(csv).toContain("Acne consult,1500");
    // comma in name → quoted
    expect(csv).toContain('"Hair, deluxe",5000');
    // CRLF line endings
    expect(csv).toContain("\r\n");
  });
  it("uses render fn when provided", () => {
    const csv = serializeRows(
      [{ key: "id", header: "ID", render: (r) => `S-${r.id}` }],
      [{ id: 1 }, { id: 2 }],
    );
    expect(csv).toContain("S-1");
    expect(csv).toContain("S-2");
  });
  it("prefixes formula-injection cells in body", () => {
    const csv = serializeRows(
      [{ key: "name", header: "Name" }],
      [{ name: "=cmd|'/c calc'!A1" }],
    );
    // The single-quote prefix is added BEFORE escaping; the cell now
    // starts with `'=` which contains no special chars, so no quoting.
    expect(csv).toContain("'=cmd|'/c calc'!A1");
  });
});

describe("csvHelpers — parseCsv", () => {
  it("strips UTF-8 BOM", () => {
    const { headers, rows } = parseCsv(`${UTF8_BOM}name,price\nFoo,100`);
    expect(headers).toEqual(["name", "price"]);
    expect(rows).toEqual([{ name: "Foo", price: "100" }]);
  });
  it("parses simple CSV", () => {
    const { rows } = parseCsv("a,b,c\n1,2,3\n4,5,6");
    expect(rows).toEqual([
      { a: "1", b: "2", c: "3" },
      { a: "4", b: "5", c: "6" },
    ]);
  });
  it("handles quoted commas", () => {
    const { rows } = parseCsv('name,price\n"Hair, deluxe",5000');
    expect(rows).toEqual([{ name: "Hair, deluxe", price: "5000" }]);
  });
  it("handles escaped quotes", () => {
    const { rows } = parseCsv('q\n"say ""hi"""');
    expect(rows).toEqual([{ q: 'say "hi"' }]);
  });
  it("handles CRLF line endings", () => {
    const { rows } = parseCsv("a,b\r\n1,2\r\n3,4");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ a: "1", b: "2" });
  });
  it("handles bare-CR line endings", () => {
    const { rows } = parseCsv("a,b\r1,2\r3,4");
    expect(rows).toHaveLength(2);
  });
  it("trims trailing empty rows", () => {
    const { rows } = parseCsv("a\n1\n\n\n");
    expect(rows).toEqual([{ a: "1" }]);
  });
  it("missing column gets empty string", () => {
    const { rows } = parseCsv("a,b,c\n1,2");
    expect(rows[0]).toEqual({ a: "1", b: "2", c: "" });
  });
  it("rejects non-string input", () => {
    expect(() => parseCsv(null)).toThrow();
    expect(() => parseCsv(42)).toThrow();
  });
});

describe("csvHelpers — buildErrorReport", () => {
  it("emits rowNumber + reason header + body", () => {
    const csv = buildErrorReport([
      { rowNumber: 2, reason: "missing name" },
      { rowNumber: 5, reason: "duplicate, second" },
    ]);
    expect(csv).toContain("rowNumber,reason");
    expect(csv).toContain("2,missing name");
    expect(csv).toContain('5,"duplicate, second"');
  });
});

describe("csvHelpers — setCsvDownloadHeaders", () => {
  it("sets Content-Type + Content-Disposition", () => {
    const calls = [];
    const res = { setHeader: (k, v) => calls.push([k, v]) };
    setCsvDownloadHeaders(res, "services-export.csv");
    expect(calls).toContainEqual(["Content-Type", "text/csv; charset=utf-8"]);
    expect(calls).toContainEqual(["Content-Disposition", 'attachment; filename="services-export.csv"']);
  });
});
