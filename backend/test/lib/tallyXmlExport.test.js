// Unit tests for backend/lib/tallyXmlExport.js
//
// Pins the Tally XML envelope contract used by GET /api/billing/export/tally.xml
// (PRD §4.4 CA / Tally export). The helper is PURE — no Prisma, no I/O —
// so this file mocks nothing.
//
// Contracts pinned:
//   - escapeXml round-trips & < > " '
//   - fmtTallyDate emits YYYYMMDD (no separators); empty on invalid
//   - tallyAmount renders to 2dp; non-finite → "0.00"
//   - Empty invoices array → still produces a well-formed <ENVELOPE>
//   - One invoice → exactly 1 <TALLYMESSAGE>; voucher number / date /
//     amounts match what was passed in
//   - Intrastate (sellerState === buyerState) → CGST + SGST blocks,
//     NO IGST
//   - Interstate (sellerState !== buyerState) → IGST block, NO
//     CGST / SGST
//   - Zero-GST → only Sales + Party ledger entries (no GST blocks)
//   - Contact names with `&` are XML-escaped in PARTYLEDGERNAME
//   - Double-entry invariant: all <AMOUNT> values sum to zero across
//     the voucher (Tally's load-bearing accounting rule)

import { describe, test, expect } from "vitest";

const { buildTallyXml, escapeXml, fmtTallyDate, tallyAmount } = await import(
  "../../lib/tallyXmlExport.js"
);

describe("escapeXml", () => {
  test("escapes the 5 XML metacharacters", () => {
    expect(escapeXml(`<a href="x">"Sharma & Sons" — it's good</a>`)).toBe(
      `&lt;a href=&quot;x&quot;&gt;&quot;Sharma &amp; Sons&quot; — it&apos;s good&lt;/a&gt;`
    );
  });
  test("returns empty string for null / undefined", () => {
    expect(escapeXml(null)).toBe("");
    expect(escapeXml(undefined)).toBe("");
  });
});

describe("fmtTallyDate", () => {
  test("emits YYYYMMDD for a Date object", () => {
    expect(fmtTallyDate(new Date(2026, 4, 21))).toBe("20260521");
  });
  test("emits YYYYMMDD for an ISO string", () => {
    // Construct an ISO string anchored to a fixed local date so the test
    // is TZ-stable: use noon local time so any TZ offset stays within
    // the same calendar date.
    const localNoon = new Date(2026, 0, 5, 12, 0, 0);
    expect(fmtTallyDate(localNoon.toISOString())).toBe("20260105");
  });
  test("zero-pads single-digit months and days", () => {
    expect(fmtTallyDate(new Date(2026, 0, 3))).toBe("20260103");
  });
  test("returns empty string on null / undefined / invalid", () => {
    expect(fmtTallyDate(null)).toBe("");
    expect(fmtTallyDate(undefined)).toBe("");
    expect(fmtTallyDate("not-a-date")).toBe("");
    expect(fmtTallyDate("")).toBe("");
  });
});

describe("tallyAmount", () => {
  test("rounds to 2dp", () => {
    expect(tallyAmount(123.456)).toBe("123.46");
    expect(tallyAmount(100)).toBe("100.00");
    expect(tallyAmount(0)).toBe("0.00");
  });
  test("emits negative verbatim", () => {
    expect(tallyAmount(-100.5)).toBe("-100.50");
  });
  test("non-finite / null / undefined → 0.00", () => {
    expect(tallyAmount(NaN)).toBe("0.00");
    expect(tallyAmount(Infinity)).toBe("0.00");
    expect(tallyAmount(null)).toBe("0.00");
    expect(tallyAmount(undefined)).toBe("0.00");
  });
});

describe("buildTallyXml", () => {
  test("empty invoices array still wraps in <ENVELOPE> + <REQUESTDATA>", () => {
    const xml = buildTallyXml({ companyName: "Acme Pvt Ltd", sellerState: "Karnataka", invoices: [] });
    expect(xml).toMatch(/^<\?xml/);
    expect(xml).toContain("<ENVELOPE>");
    expect(xml).toContain("</ENVELOPE>");
    expect(xml).toContain("<SVCURRENTCOMPANY>Acme Pvt Ltd</SVCURRENTCOMPANY>");
    expect(xml).not.toContain("<TALLYMESSAGE>");
  });

  test("one invoice → exactly 1 <TALLYMESSAGE> with the right voucher number, date, amounts", () => {
    const xml = buildTallyXml({
      companyName: "Acme Pvt Ltd",
      sellerState: "Karnataka",
      invoices: [
        {
          invoiceNumber: "INV-001",
          issueDate: new Date(2026, 4, 21),
          contactName: "Ravi Kumar",
          buyerState: "Karnataka",
          subtotal: 1000,
          cgstAmount: 90,
          sgstAmount: 90,
          totalAmount: 1180,
        },
      ],
    });
    const matches = xml.match(/<TALLYMESSAGE>/g) || [];
    expect(matches.length).toBe(1);
    expect(xml).toContain("<VOUCHERNUMBER>INV-001</VOUCHERNUMBER>");
    expect(xml).toContain("<DATE>20260521</DATE>");
    expect(xml).toContain("<AMOUNT>1000.00</AMOUNT>");
    expect(xml).toContain("<AMOUNT>90.00</AMOUNT>");
    expect(xml).toContain("<AMOUNT>-1180.00</AMOUNT>");
  });

  test("intrastate sale → CGST + SGST blocks, NO IGST", () => {
    const xml = buildTallyXml({
      companyName: "Acme Pvt Ltd",
      sellerState: "Karnataka",
      invoices: [
        {
          invoiceNumber: "INV-002",
          issueDate: new Date(2026, 4, 21),
          contactName: "Karnataka Customer",
          buyerState: "Karnataka",
          subtotal: 1000,
          cgstAmount: 90,
          sgstAmount: 90,
          igstAmount: 0,
          totalAmount: 1180,
        },
      ],
    });
    expect(xml).toContain("<LEDGERNAME>CGST Output</LEDGERNAME>");
    expect(xml).toContain("<LEDGERNAME>SGST Output</LEDGERNAME>");
    expect(xml).not.toContain("<LEDGERNAME>IGST Output</LEDGERNAME>");
  });

  test("interstate sale → IGST block, NO CGST / SGST", () => {
    const xml = buildTallyXml({
      companyName: "Acme Pvt Ltd",
      sellerState: "Karnataka",
      invoices: [
        {
          invoiceNumber: "INV-003",
          issueDate: new Date(2026, 4, 21),
          contactName: "Maharashtra Customer",
          buyerState: "Maharashtra",
          subtotal: 1000,
          cgstAmount: 0,
          sgstAmount: 0,
          igstAmount: 180,
          totalAmount: 1180,
        },
      ],
    });
    expect(xml).toContain("<LEDGERNAME>IGST Output</LEDGERNAME>");
    expect(xml).not.toContain("<LEDGERNAME>CGST Output</LEDGERNAME>");
    expect(xml).not.toContain("<LEDGERNAME>SGST Output</LEDGERNAME>");
  });

  test("zero-GST invoice → only Sales Account + Party Ledger entries, no GST blocks", () => {
    const xml = buildTallyXml({
      companyName: "Acme Pvt Ltd",
      sellerState: "Karnataka",
      invoices: [
        {
          invoiceNumber: "INV-004",
          issueDate: new Date(2026, 4, 21),
          contactName: "Export Customer",
          buyerState: "Karnataka",
          subtotal: 1000,
          cgstAmount: 0,
          sgstAmount: 0,
          igstAmount: 0,
          totalAmount: 1000,
        },
      ],
    });
    expect(xml).toContain("<LEDGERNAME>Sales Account</LEDGERNAME>");
    expect(xml).toContain("<LEDGERNAME>Export Customer</LEDGERNAME>");
    expect(xml).not.toContain("<LEDGERNAME>CGST Output</LEDGERNAME>");
    expect(xml).not.toContain("<LEDGERNAME>SGST Output</LEDGERNAME>");
    expect(xml).not.toContain("<LEDGERNAME>IGST Output</LEDGERNAME>");
  });

  test("contact name containing & is XML-escaped in PARTYLEDGERNAME", () => {
    const xml = buildTallyXml({
      companyName: "Acme & Co",
      sellerState: "Karnataka",
      invoices: [
        {
          invoiceNumber: "INV-005",
          issueDate: new Date(2026, 4, 21),
          contactName: "Sharma & Sons",
          buyerState: "Karnataka",
          subtotal: 1000,
          totalAmount: 1000,
        },
      ],
    });
    expect(xml).toContain("<SVCURRENTCOMPANY>Acme &amp; Co</SVCURRENTCOMPANY>");
    expect(xml).toContain("<PARTYLEDGERNAME>Sharma &amp; Sons</PARTYLEDGERNAME>");
    expect(xml).toContain("<LEDGERNAME>Sharma &amp; Sons</LEDGERNAME>");
    expect(xml).not.toContain("Sharma & Sons"); // unescaped form must NOT leak
  });

  test("double-entry invariant: all <AMOUNT> values sum to zero across the voucher", () => {
    const xml = buildTallyXml({
      companyName: "Acme Pvt Ltd",
      sellerState: "Karnataka",
      invoices: [
        {
          invoiceNumber: "INV-006",
          issueDate: new Date(2026, 4, 21),
          contactName: "Customer",
          buyerState: "Karnataka",
          subtotal: 1000,
          cgstAmount: 90,
          sgstAmount: 90,
          totalAmount: 1180,
        },
      ],
    });
    const amounts = Array.from(xml.matchAll(/<AMOUNT>(-?\d+\.\d{2})<\/AMOUNT>/g)).map((m) => Number(m[1]));
    expect(amounts.length).toBeGreaterThanOrEqual(4); // Sales + CGST + SGST + Party
    const sum = amounts.reduce((acc, n) => acc + n, 0);
    expect(Math.abs(sum)).toBeLessThan(0.005); // round-trip noise tolerance
  });

  test("multiple invoices produce one <TALLYMESSAGE> per row", () => {
    const xml = buildTallyXml({
      companyName: "Acme Pvt Ltd",
      sellerState: "Karnataka",
      invoices: [
        { invoiceNumber: "INV-A", issueDate: new Date(2026, 4, 1), contactName: "A", buyerState: "Karnataka", subtotal: 100, totalAmount: 100 },
        { invoiceNumber: "INV-B", issueDate: new Date(2026, 4, 2), contactName: "B", buyerState: "Karnataka", subtotal: 200, totalAmount: 200 },
        { invoiceNumber: "INV-C", issueDate: new Date(2026, 4, 3), contactName: "C", buyerState: "Maharashtra", subtotal: 300, igstAmount: 54, totalAmount: 354 },
      ],
    });
    const matches = xml.match(/<TALLYMESSAGE>/g) || [];
    expect(matches.length).toBe(3);
    expect(xml).toContain("<VOUCHERNUMBER>INV-A</VOUCHERNUMBER>");
    expect(xml).toContain("<VOUCHERNUMBER>INV-B</VOUCHERNUMBER>");
    expect(xml).toContain("<VOUCHERNUMBER>INV-C</VOUCHERNUMBER>");
  });

  test("missing buyerState defaults to sellerState (intrastate)", () => {
    const xml = buildTallyXml({
      companyName: "Acme Pvt Ltd",
      sellerState: "Karnataka",
      invoices: [
        {
          invoiceNumber: "INV-007",
          issueDate: new Date(2026, 4, 21),
          contactName: "Unknown State Customer",
          // buyerState omitted on purpose
          subtotal: 1000,
          cgstAmount: 90,
          sgstAmount: 90,
          totalAmount: 1180,
        },
      ],
    });
    expect(xml).toContain("<LEDGERNAME>CGST Output</LEDGERNAME>");
    expect(xml).toContain("<LEDGERNAME>SGST Output</LEDGERNAME>");
    expect(xml).not.toContain("<LEDGERNAME>IGST Output</LEDGERNAME>");
  });

  test("notes + billingAddress are concatenated into NARRATION, XML-escaped", () => {
    const xml = buildTallyXml({
      companyName: "Acme Pvt Ltd",
      sellerState: "Karnataka",
      invoices: [
        {
          invoiceNumber: "INV-008",
          issueDate: new Date(2026, 4, 21),
          contactName: "Customer",
          buyerState: "Karnataka",
          subtotal: 1000,
          totalAmount: 1000,
          notes: "Travel Stall <Bali> package",
          billingAddress: "123 Main St, Bengaluru",
        },
      ],
    });
    expect(xml).toContain("Travel Stall &lt;Bali&gt; package");
    expect(xml).toContain("123 Main St, Bengaluru");
  });
});
