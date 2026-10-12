// A4 presentation of an already-calculated travel invoice. No ledger writes.
const PDFDocument = require("pdfkit");
const sacMapper = require("../lib/hsnSacMapper");
const gstCalculation = require("../lib/gstCalculation");

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function lineTax(line) {
  const persisted = ["cgstAmount", "sgstAmount", "igstAmount"].some((key) => line[key] != null);
  const rate = persisted
    ? number(line.cgstPercent) + number(line.sgstPercent) + number(line.igstPercent)
    : line.gstPercent != null ? number(line.gstPercent) : gstCalculation.gstRateForCategory(line.lineType);
  const taxable = line.taxableValue != null ? number(line.taxableValue) : number(line.amount);
  const calculated = persisted ? null : gstCalculation.computeGstSplit({
    taxableAmount: taxable, gstPercent: rate, isInterstate: !!line.isInterstate,
  });
  const cgst = persisted ? number(line.cgstAmount) : number(calculated.cgst);
  const sgst = persisted ? number(line.sgstAmount) : number(calculated.sgst);
  const igst = persisted ? number(line.igstAmount) : number(calculated.igst);
  return { taxable, rate, cgst, sgst, igst };
}

function renderTravelInvoiceLayout({ invoice, lines, tenant, branding, logoBuffer, brandLabel, title, footerText, voucher, applyFonts, streamToBuffer, formatDate }) {
  // 56 pt is approximately 19.8 mm, within the requested print-safe margins.
  const doc = new PDFDocument({ size: "A4", margin: 56, bufferPages: true,
    info: { Producer: `Globussoft CRM (brand-kit: ${branding.source})` } });
  applyFonts(doc);
  const result = streamToBuffer(doc);
  const W = doc.page.width;
  const left = 56;
  const right = W - 56;
  const width = right - left;
  const isHexColor = (value) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
  const navy = branding.configuredColors && isHexColor(branding.primaryColor)
    ? branding.primaryColor : "#14253F";
  const teal = branding.configuredColors && isHexColor(branding.accentColor)
    ? branding.accentColor : "#0F766E";
  const ink = navy;
  const muted = "#526174";
  const border = "#D8E0E8";
  const pale = "#F4F7FA";
  const safe = (value) => value == null || value === "" ? "" : String(value);
  const money = (value, currency = invoice.currency || "INR") => {
    const amount = number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${currency} ${amount}`;
  };
  const date = (value) => value ? formatDate(value) : "—";
  const cfg = branding.identity || {};
  const showTax = invoice.subBrand !== "tmc";
  const legalEntity = cfg.legalEntity && typeof cfg.legalEntity === "object" ? cfg.legalEntity : {};
  const registeredOffice = cfg.registeredOffice && typeof cfg.registeredOffice === "object" ? cfg.registeredOffice : {};
  const company = cfg.company && typeof cfg.company === "object" ? cfg.company : {};
  const seller = safe(cfg.legalName || cfg.registeredName || cfg.registeredCompanyName ||
    cfg.companyLegalName || cfg.legalEntityName || legalEntity.legalName || legalEntity.name ||
    company.legalName || cfg.companyName || company.name || tenant?.name || cfg.displayName || brandLabel || "Travel CRM");
  const addressValue = cfg.registeredAddress || cfg.registeredOfficeAddress || cfg.legalAddress ||
    cfg.companyAddress || registeredOffice.address || registeredOffice ||
    legalEntity.registeredAddress || legalEntity.address ||
    company.registeredAddress || company.address || cfg.address || cfg.addressLine;
  const sellerAddress = addressValue && typeof addressValue === "object"
    ? [addressValue.line1 || addressValue.addressLine1, addressValue.line2 || addressValue.addressLine2,
      addressValue.city, addressValue.state, addressValue.postalCode || addressValue.pincode, addressValue.country]
      .filter(Boolean).join(", ")
    : safe(addressValue);
  const sellerGstin = cfg.registeredGstin || cfg.companyGstin ||
    registeredOffice.gstin || legalEntity.gstin || company.gstin || cfg.gstin;
  const sellerLines = [
    brandLabel && brandLabel !== seller ? brandLabel : null,
    sellerAddress,
    sellerGstin && `GSTIN  ${sellerGstin}`,
    [cfg.email || cfg.contactEmail, cfg.phone || cfg.contactPhone, cfg.website].filter(Boolean).join("  ·  "),
  ].filter(Boolean);
  const bottom = () => doc.page.height - 80;
  let y = 0;
  const text = (value, x, top, w, size = 9, bold = false, color = ink, align = "left") => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(color);
    const str = safe(value) || "—";
    const h = doc.heightOfString(str, { width: w, align, lineGap: 2 });
    doc.text(str, x, top, { width: w, align, lineGap: 2 });
    return h;
  };
  const singleLineText = (value, x, top, w, size = 7, bold = false, color = muted, align = "right") => {
    const str = safe(value);
    const font = bold ? "Helvetica-Bold" : "Helvetica";
    let fittedSize = size;
    doc.font(font);
    while (fittedSize > 5.5 && doc.fontSize(fittedSize).widthOfString(str) > w) fittedSize -= 0.25;
    doc.font(font).fontSize(fittedSize).fillColor(color);
    // Footer rows must never wrap into a new PDFKit page.
    doc.text(str, x, top, { width: w, align, lineBreak: false });
  };
  const page = (continued = false) => {
    if (continued) doc.addPage();
    // PDFs always print on white paper, regardless of the app's color mode.
    doc.rect(0, 0, W, doc.page.height).fill("#FFFFFF");
    doc.rect(0, 0, W, 5).fill(teal);
    doc.rect(left, 10, width, 1).fill(navy);
    if (continued) text(brandLabel, left, 24, width, 9, true, navy);
    doc.moveTo(left, doc.page.height - 48).lineTo(right, doc.page.height - 48)
      .lineWidth(0.5).strokeColor(border).stroke();
    y = continued ? 49 : 38;
  };
  const ensure = (height) => { if (y + height > bottom()) page(true); };
  const rule = () => { doc.moveTo(left, y).lineTo(right, y).lineWidth(0.6).strokeColor(border).stroke(); y += 9; };
  const section = (label) => { ensure(30); text(label, left, y, width, 9, true, navy); y += 16; };
  page();
  // A quiet masthead leaves the logo and legal identity clear on paper.
  if (logoBuffer) {
    try { doc.image(logoBuffer, left, y, { fit: [70, 46] }); } catch (_) { /* malformed optional logo */ }
  }
  const sellerX = logoBuffer ? left + 82 : left;
  const invoiceCardX = right - 208;
  const sellerW = Math.max(110, invoiceCardX - sellerX - 14);
  let sellerY = y;
  sellerY += text(seller, sellerX, sellerY, sellerW, 14, true, navy) + 2;
  for (const line of sellerLines) sellerY += text(line, sellerX, sellerY, sellerW, 8, false, muted) + 1;
  const recordedPaid = number(invoice.amountPaid != null ? invoice.amountPaid : invoice.totalPaid || invoice.paidAmount);
  const payableForStatus = invoice.totalAmount != null ? number(invoice.totalAmount) :
    lines.reduce((sum, line) => sum + (line.amount != null ? number(line.amount) : number(line.quantity) * number(line.unitPrice)), 0);
  const status = invoice.status === "Voided" ? "VOIDED" :
    recordedPaid >= payableForStatus && payableForStatus > 0 ? "PAID" :
      recordedPaid > 0 ? "PARTIALLY PAID" : "UNPAID";
  doc.roundedRect(invoiceCardX, y - 5, 208, invoice.placeOfSupply ? 82 : 70, 7).fill(pale);
  text(title.toLocaleUpperCase(), invoiceCardX + 12, y + 3, 184, 14, true, navy, "right");
  doc.roundedRect(invoiceCardX + 12, y + 26, 82, 18, 8).fill(status === "PAID" ? "#E6F4F1" : "#FFF4E5");
  text(status, invoiceCardX + 14, y + 31, 78, 8, true, status === "PAID" ? teal : "#8A5200", "center");
  text(invoice.invoiceNum || invoice.id || "—", invoiceCardX + 98, y + 30, 98, 9, true, ink, "right");
  text(`Issued ${date(invoice.issuedDate || invoice.createdAt)}`, invoiceCardX + 12, y + 53, 92, 7.5, false, muted);
  text(`Due ${date(invoice.dueDate)}`, invoiceCardX + 104, y + 53, 92, 7.5, false, muted, "right");
  if (invoice.placeOfSupply) text(`Place of supply: ${invoice.placeOfSupply}`,
    invoiceCardX + 12, y + 68, 184, 7.5, false, muted, "right");
  y = Math.max(sellerY + 8, y + (invoice.placeOfSupply ? 88 : 76));
  rule();
  const half = (width - 24) / 2;
  const bill = [invoice.contactName || invoice.customerName, invoice.contactCompany,
    invoice.billingAddress, invoice.contactGstin && `GSTIN  ${invoice.contactGstin}`,
    invoice.contactEmail, invoice.contactPhone].filter(Boolean);
  const billTop = y;
  const trip = invoice.trip || {};
  const destination = invoice.destination || trip.destination;
  const travelDates = invoice.travelStartDate || trip.startDate
    ? `${date(invoice.travelStartDate || trip.startDate)} – ${date(invoice.travelEndDate || trip.endDate)}` : null;
  const travellers = invoice.travellerList || invoice.travellerName || trip.travellers;
  const reference = invoice.tripReference || trip.tripCode || trip.reference;
  const tripRows = [destination, travelDates,
    [travellers && `Travellers: ${Array.isArray(travellers) ? travellers.join(", ") : travellers}`,
      reference && `Booking reference: ${reference}`].filter(Boolean).join("  ·  ")].filter(Boolean);
  const billRows = bill.length ? bill : ["Customer details unavailable"];
  const billContentHeight = billRows.reduce((height, line, index) => {
    doc.font(index === 0 && bill.length ? "Helvetica-Bold" : "Helvetica").fontSize(index === 0 && bill.length ? 10 : 8);
    return height + doc.heightOfString(safe(line), { width: half - 24, lineGap: 2 }) + 1;
  }, 0);
  const tripContentHeight = tripRows.reduce((height, line, index) => {
    doc.font(index === 0 && destination ? "Helvetica-Bold" : "Helvetica").fontSize(index === 0 && destination ? 10 : 8);
    return height + doc.heightOfString(safe(line), { width: half - 24, lineGap: 2 }) + 2;
  }, 0);
  const infoCardHeight = Math.max(92, 38 + Math.max(billContentHeight, tripContentHeight) + 4);
  let leftContentY = billTop + 29;
  doc.roundedRect(left, billTop, width, infoCardHeight, 7).lineWidth(0.7).strokeColor(border).fillAndStroke("#F7F9FB", border);
  text("BILL TO", left + 12, billTop + 10, half - 12, 8, true, muted);
  for (const [i, line] of bill.entries()) leftContentY += text(line, left + 12, leftContentY, half - 24, i === 0 ? 10 : 8, i === 0, i === 0 ? ink : muted) + 1;
  if (!bill.length) leftContentY += text("Customer details unavailable", left + 12, leftContentY, half - 24, 9, false, muted);
  const tripX = left + half + 24;
  const tripW = half - 24;
  doc.moveTo(tripX - 12, billTop + 10).lineTo(tripX - 12, billTop + infoCardHeight - 10)
    .lineWidth(0.5).strokeColor(border).stroke();
  text("TRIP INFORMATION", tripX, billTop + 10, tripW, 8, true, muted);
  let tripY = billTop + 29;
  for (const [index, row] of tripRows.entries()) {
    tripY += text(row, tripX, tripY, tripW, index === 0 && destination ? 10 : 8,
      index === 0 && !!destination, index === 0 && destination ? ink : muted) + 2;
  }
  if (!tripRows.length) text("Trip details unavailable", tripX, tripY, tripW, 8, false, muted);
  y = billTop + infoCardHeight + 10;

  if (voucher) {
    section("Voucher Details");
    const travellers = Array.isArray(voucher.travellers) ? voucher.travellers.join(", ") : voucher.travellers;
    text("Travellers:", left, y, 76, 8, true, muted);
    const travellerH = text(travellers || "—", left + 78, y, width - 78, 8.5);
    y += Math.max(16, travellerH) + 9;
    if (!voucher.lines.length) {
      ensure(27);
      text("(No fulfillment lines yet — add Hotel / Transfer / Activity lines to populate this block.)",
        left, y, width, 8.5, false, muted);
      y += 25;
    } else {
      const vx = [left, left + 80, left + 264, left + 382];
      const vw = [72, 175, 110, width - 382];
      const voucherHeader = () => {
        doc.rect(left, y, width, 22).fill(pale);
        ["Subtype", "Description", "Supplier Conf #", "Service Date"].forEach((label, i) =>
          text(label, vx[i] + 5, y + 6, vw[i] - 5, 7.5, true, muted));
        y += 22;
      };
      ensure(45);
      voucherHeader();
      for (const row of voucher.lines) {
        doc.font("Helvetica").fontSize(8);
        const h = Math.max(25, ...[row.subtype, row.description, row.confirmation, row.serviceDate]
          .map((value, i) => doc.heightOfString(safe(value) || "—", { width: vw[i] - 9 }) + 12));
        if (y + h > bottom()) { page(true); voucherHeader(); }
        [row.subtype, row.description, row.confirmation, row.serviceDate].forEach((value, i) =>
          text(value, vx[i] + 5, y + 6, vw[i] - 9, 8));
        y += h;
        doc.moveTo(left, y).lineTo(right, y).lineWidth(0.4).strokeColor(border).stroke();
      }
    }
    y += 9;
    rule();
  }

  ensure(75);
  section("Service details");
  const cols = [left, left + 356, left + 407];
  const widths = [348, 43, width - 407];
  const tableHeader = () => {
    doc.roundedRect(left, y, width, 23, 4).fill("#EAF0F6");
    ["DESCRIPTION", "QTY", "AMOUNT"].forEach((label, i) =>
      text(label, cols[i] + (i ? 0 : 9), y + 7, widths[i] - (i ? 0 : 9), 7.5, true, navy, i > 0 ? "right" : "left"));
    y += 23;
  };
  tableHeader();
  let subtotal = 0;
  let taxableTotal = 0;
  let cgstTotal = 0;
  let sgstTotal = 0;
  let igstTotal = 0;
  const summaries = new Map();
  for (const [index, line] of lines.entries()) {
    const amount = line.amount != null ? number(line.amount) : number(line.quantity) * number(line.unitPrice);
    subtotal += amount;
    const tax = lineTax({ ...line, amount, isInterstate: invoice.placeOfSupplyInterstate });
    const sac = line.hsnSac != null ? safe(line.hsnSac) : sacMapper.sacForLineType(line.lineType);
    if (sac) {
      taxableTotal += tax.taxable;
      const key = `${sac}|${tax.rate}`;
      const group = summaries.get(key) || { sac, rate: tax.rate, taxable: 0, tax: 0, count: 0 };
      group.taxable += tax.taxable;
      group.tax += tax.cgst + tax.sgst + tax.igst;
      group.count++;
      summaries.set(key, group);
    }
    cgstTotal += tax.cgst; sgstTotal += tax.sgst; igstTotal += tax.igst;
    const serviceLabels = {
      per_pax: "Travel package (per traveller)",
      per_room: "Accommodation",
      per_night: "Accommodation (per night)",
      per_trip: "Travel package",
      addon: "Additional travel service",
      fee: "Service fee",
      tax: "Tax",
      tcs: "Tax collected at source",
      tds: "Tax deducted at source",
      other: "Travel service",
    };
    const description = safe(line.description) || serviceLabels[line.lineType] || "Travel service";
    const context = [];
    const destination = safe(invoice.destination || trip.destination);
    if (destination && !description.toLocaleLowerCase().includes(destination.toLocaleLowerCase())) {
      context.push(destination);
    }
    const serviceStart = line.serviceStartDate || invoice.travelStartDate || trip.startDate;
    const serviceEnd = line.serviceEndDate || invoice.travelEndDate || trip.endDate;
    if (serviceStart || serviceEnd) {
      context.push([serviceStart && date(serviceStart), serviceEnd && date(serviceEnd)].filter(Boolean).join(" – "));
    }
    const bookingReference = line.bookingRef || line.pnr;
    const lineDetails = [
      context.join("  ·  "),
      bookingReference && `Ref: ${safe(bookingReference)}`,
      showTax && sac && `SAC ${sac}`,
    ].filter(Boolean);
    let remaining = [description, lineDetails.join("  ·  ")].filter(Boolean).join("\n");
    let firstFragment = true;
    while (remaining) {
      if (bottom() - y < 40) { page(true); tableHeader(); }
      doc.font("Helvetica").fontSize(8.5);
      const measure = (value) => doc.heightOfString(value, { width: widths[0] - 18, lineGap: 2 });
      const fullRowHeight = Math.max(27, measure(remaining) + 12);
      if (y + fullRowHeight > bottom() && fullRowHeight <= bottom() - 49) {
        page(true);
        tableHeader();
        continue;
      }
      const available = bottom() - y - 16;
      let fragment = remaining;
      if (measure(fragment) > available) {
        let lo = 1; let hi = remaining.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (measure(remaining.slice(0, mid)) <= available) lo = mid;
          else hi = mid - 1;
        }
        const breakAt = remaining.lastIndexOf(" ", lo);
        fragment = remaining.slice(0, breakAt > lo * 0.65 ? breakAt : lo).trimEnd();
      }
      if (!fragment) { page(true); tableHeader(); continue; }
      const rowH = Math.max(27, measure(fragment) + 12);
      if (index % 2 === 1) doc.rect(left, y, width, rowH).fill(pale);
      text(fragment, cols[0] + 9, y + 6, widths[0] - 18, 8.5);
      if (firstFragment) {
        text(line.quantity == null ? "—" : line.quantity, cols[1], y + 6, widths[1], 8.5, false, ink, "right");
        text(money(amount), cols[2], y + 6, widths[2], 8.5, true, ink, "right");
      }
      y += rowH;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.4).strokeColor(border).stroke();
      remaining = remaining.slice(fragment.length).trimStart();
      firstFragment = false;
      if (remaining) { page(true); tableHeader(); }
    }
  }
  if (!lines.length) { text("No line items recorded", left + 9, y + 9, width - 18, 9, false, muted); y += 33; }
  y += 10;
  // Keep the tax summary, balances and terms together on the final content
  // page instead of pushing a short terms block onto a page by itself.
  ensure(showTax ? 260 + summaries.size * 24 : 170);

  if (showTax && summaries.size) {
    section("HSN/SAC Summary");
    const header = () => {
      doc.rect(left, y, width, 23).fill("#EAF0F6");
      text("CODE / RATE", left + 8, y + 6, 80, 7.5, true, navy);
      text("DESCRIPTION", left + 96, y + 6, 197, 7.5, true, navy);
      text("TAXABLE VALUE", left + 300, y + 6, 104, 7.5, true, navy, "right");
      text("TAX", left + 410, y + 6, width - 418, 7.5, true, navy, "right");
      y += 23;
    };
    header();
    for (const group of [...summaries.values()].sort((a, b) => a.sac.localeCompare(b.sac) || a.rate - b.rate)) {
      doc.font("Helvetica").fontSize(8);
      const desc = Object.prototype.hasOwnProperty.call(sacMapper.SAC_DESCRIPTIONS, group.sac)
        ? sacMapper.descriptionForSac(group.sac) : "See invoice items";
      const h = Math.max(24, doc.heightOfString(desc, { width: 191 }) + 8);
      if (y + h > bottom()) { page(true); header(); }
      text(`${group.sac} / ${group.rate}%`, left + 8, y + 8, 80, 8);
      text(desc, left + 96, y + 8, 191, 8);
      text(money(group.taxable), left + 296, y + 8, 108, 8, false, ink, "right");
      text(money(group.tax), left + 406, y + 8, width - 414, 8, false, ink, "right");
      y += h;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.4).strokeColor(border).stroke();
    }
    y += 10;
  }

  const total = invoice.totalAmount != null ? number(invoice.totalAmount) : subtotal;
  const received = Math.max(0, number(invoice.amountPaid != null ? invoice.amountPaid : invoice.totalPaid || invoice.paidAmount));
  const balance = Math.max(0, total - received);
  const discount = number(invoice.discountAmount);
  const taxPersisted = ["cgstAmount", "sgstAmount", "igstAmount"].some((key) => invoice[key] != null);
  if (taxPersisted) {
    cgstTotal = number(invoice.cgstAmount); sgstTotal = number(invoice.sgstAmount); igstTotal = number(invoice.igstAmount);
  }
  const taxReportedSeparately = Math.abs(subtotal - discount + cgstTotal + sgstTotal + igstTotal - total) > 0.01;
  const totals = [["Subtotal", subtotal]];
  if (discount) totals.push(["Discount", -discount]);
  if (showTax) {
    totals.push(["Taxable amount", taxableTotal]);
    if (cgstTotal) totals.push([taxReportedSeparately ? "CGST (reported)" : "CGST", cgstTotal]);
    if (sgstTotal) totals.push([taxReportedSeparately ? "SGST (reported)" : "SGST", sgstTotal]);
    if (igstTotal) totals.push([taxReportedSeparately ? "IGST (reported)" : "IGST", igstTotal]);
  }
  totals.push(["Grand total", total], ["Amount received", received], ["Outstanding balance", balance]);
  const paymentTransactions = Array.isArray(invoice.paymentTransactions) ? invoice.paymentTransactions : [];
  const paymentParts = [cfg.bankName && `Bank: ${cfg.bankName}`,
    cfg.bankAccountNumber && `Account: ${cfg.bankAccountNumber}`,
    cfg.bankIfsc && `IFSC: ${cfg.bankIfsc}`,
    cfg.upiId && `UPI: ${cfg.upiId}`].filter(Boolean);
  const paymentRows = paymentTransactions.map((payment) => {
    const method = safe(payment.method).replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase());
    return {
      label: [payment.paidAt && date(payment.paidAt), method || "Payment recorded",
        payment.reference && `Ref: ${safe(payment.reference)}`].filter(Boolean).join("  ·  "),
      amount: payment.amount == null ? "—" : money(payment.amount, payment.currency || invoice.currency || "INR"),
    };
  });
  const cardGap = 16;
  const cardWidth = (width - cardGap) / 2;
  const paymentTextRows = [...(paymentParts.length ? [paymentParts.join("  ·  ")] : []),
    ...(paymentRows.length ? paymentRows : ["No payment transactions recorded"])];
  const paymentHeaderHeight = paymentRows.length ? 13 : 0;
  doc.font("Helvetica").fontSize(7.8);
  const paymentRowHeights = paymentTextRows.map((row) => {
    const label = typeof row === "string" ? row : row.label;
    const rowWidth = typeof row === "string" ? cardWidth - 22 : cardWidth - 108;
    return Math.max(14, doc.heightOfString(label, { width: rowWidth, lineGap: 1 }) + 7);
  });
  const totalsHeight = 37 + totals.length * 16;
  const paymentHeight = 43 + paymentHeaderHeight + paymentRowHeights.reduce((sum, item) => sum + item, 0);
  if (y + Math.max(totalsHeight, paymentHeight) > bottom()) page(true);
  const cardsTop = y;
  const paymentX = left;
  const totalsX = left + cardWidth + cardGap;
  const totalsCardHeight = 37 + totals.length * 16;
  const paymentCardHeight = 41 + paymentHeaderHeight + paymentRowHeights.reduce((sum, item) => sum + item, 0);
  doc.roundedRect(paymentX, cardsTop, cardWidth, paymentCardHeight, 7)
    .lineWidth(0.7).strokeColor(border).fillAndStroke("#F7F9FB", border);
  doc.roundedRect(totalsX, cardsTop, cardWidth, totalsCardHeight, 7)
    .lineWidth(0.7).strokeColor(border).fillAndStroke("#FFFFFF", border);
  text("PAYMENT INFORMATION", paymentX + 11, cardsTop + 10, cardWidth - 22, 8, true, muted);
  let paymentY = cardsTop + 29;
  let paymentHeaderDrawn = false;
  paymentTextRows.forEach((row, index) => {
    if (typeof row === "string") {
      text(row, paymentX + 11, paymentY, cardWidth - 22, 7.8, true,
        index < paymentParts.length ? muted : ink);
    } else {
      if (!paymentHeaderDrawn) {
        text("DATE / METHOD / REFERENCE", paymentX + 11, paymentY, cardWidth - 112, 6.3, true, muted);
        text("AMOUNT", paymentX + cardWidth - 93, paymentY, 82, 6.3, true, muted, "right");
        paymentY += paymentHeaderHeight;
        paymentHeaderDrawn = true;
      }
      text(row.label, paymentX + 11, paymentY, cardWidth - 108, 7.4, false, ink);
      text(row.amount, paymentX + cardWidth - 93, paymentY, 82, 7.4, true, ink, "right");
    }
    paymentY += paymentRowHeights[index];
    if (index < paymentTextRows.length - 1) {
      doc.moveTo(paymentX + 11, paymentY - 3).lineTo(paymentX + cardWidth - 11, paymentY - 3)
        .lineWidth(0.35).strokeColor(border).stroke();
    }
  });
  text("INVOICE SUMMARY", totalsX + 11, cardsTop + 10, cardWidth - 22, 8, true, muted);
  let totalsY = cardsTop + 26;
  for (const [label, value] of totals) {
    const highlight = label === "Grand total" || label === "Outstanding balance";
    if (highlight) doc.roundedRect(totalsX + 7, totalsY - 2, cardWidth - 14, 18, 3)
      .fill(label === "Outstanding balance" ? "#E6F4F1" : pale);
    const totalColor = label === "Outstanding balance" ? teal : ink;
    text(label, totalsX + 11, totalsY, cardWidth - 100, 8.2, highlight, highlight ? totalColor : muted);
    text(money(value), totalsX + cardWidth - 92, totalsY, 81, 8.2, highlight, totalColor, "right");
    totalsY += 16;
  }
  y = cardsTop + Math.max(paymentCardHeight, totalsCardHeight) + 12;

  const terms = safe(invoice.paymentTerms || cfg.paymentTerms) ||
    (balance === 0 ? "Payment received in full. Thank you." :
      invoice.dueDate ? `Please pay by ${date(invoice.dueDate)} and quote invoice ${invoice.invoiceNum || invoice.id}.` :
        `Please quote invoice ${invoice.invoiceNum || invoice.id} with your payment.`);
  ensure(60);
  rule();
  section("Terms & Conditions");
  const conditions = invoice.termsAndConditions || cfg.termsAndConditions;
  y += text([terms, conditions].filter(Boolean).join("\n"), left + 8, y, width - 16, 8.5) + 9;
  const signature = invoice.authorizedSignature || cfg.authorizedSignature;
  if (signature) {
    ensure(48);
    text(`Authorized by ${signature}`, right - 220, y, 220, 8.5, true, navy, "right");
    y += 24;
  }
  // Capture the complete page range after laying out all invoice content,
  // then number every buffered page against that final count.
  const pageRange = doc.bufferedPageRange();
  const pageCount = pageRange.count;
  const firstPage = pageRange.start;
  for (let pageIndex = firstPage; pageIndex < firstPage + pageCount; pageIndex++) {
    doc.switchToPage(pageIndex);
    const footerY = doc.page.height - 78;
    singleLineText(footerText, left, footerY, 250, 7, false, muted, "left");
    const displayedPage = pageIndex - firstPage + 1;
    singleLineText(`${invoice.invoiceNum || invoice.id || "Invoice"}  ·  Page ${displayedPage} of ${pageCount}`,
      left + 258, footerY, width - 258, 7, false, muted, "right");
  }
  doc.end();
  return result;
}

module.exports = { renderTravelInvoiceLayout, lineTax };
