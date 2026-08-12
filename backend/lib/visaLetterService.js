const PDFDocument = require("pdfkit");

const LETTER_TEMPLATE_VERSION = 2;
const LETTER_STYLES = {
  margin: 68,
  titleSize: 24,
  dateSize: 12.5,
  subjectSize: 13.25,
  bodySize: 12,
  footerSize: 11.25,
  titleColor: "#17336d",
  bodyColor: "#1a1a1a",
  mutedColor: "#4b5563",
  lineColor: "#95a6c5",
  iconFill: "#17336d",
};

function letterContent(title, paragraphs) {
  return [`<h1>${title}</h1>`, ...paragraphs.map((paragraph) => `<p>${paragraph}</p>`)].join("\n");
}

const DEFAULT_LETTER_TEMPLATES = [
  {
    code: "parental-consent-letter",
    name: "Parental Consent Letter",
    documentType: "Parental Consent Letter",
    fileName: "parental-consent-letter.pdf",
    version: LETTER_TEMPLATE_VERSION,
    requiredFields: [
      { field: "today_date", label: "Current date" },
      { field: "consulate_name", label: "Consulate name" },
      { field: "consulate_city", label: "Consulate city" },
      { field: "father_name", label: "Father or guardian name" },
      { field: "mother_name", label: "Mother or guardian name" },
      { field: "child_name", label: "Child name" },
      { field: "passport_no", label: "Passport number" },
      { field: "destination_country", label: "Destination country" },
      { field: "travel_start_date", label: "Travel start date" },
      { field: "travel_end_date", label: "Travel end date" },
      { field: "guardian_phone", label: "Guardian phone" },
      { field: "guardian_email", label: "Guardian email" },
    ],
    contentHtml: letterContent("Parental Consent Letter", [
      "Date: {{today_date}}",
      "To,",
      "The Visa Officer<br>{{consulate_name}}<br>{{consulate_city}}",
      "Subject: Consent for travel of {{child_name}}",
      "Dear Sir/Madam,",
      "We, {{father_name}} and {{mother_name}}, parents or legal guardians of {{child_name}}, holder of passport number {{passport_no}}, give our consent for the child to travel to {{destination_country}} from {{travel_start_date}} to {{travel_end_date}}.",
      "We confirm that all information and supporting documents submitted for this visa application are true to the best of our knowledge.",
      "We kindly request you to consider this consent letter in support of the visa application.",
      "Thank you for your time and consideration.",
      "Sincerely,",
      "Father or guardian signature: {{father_name}}<br>Parent / Legal Guardian",
      "Mother or guardian signature: {{mother_name}}<br>Parent / Legal Guardian",
      "Guardian contact: {{guardian_phone}} / {{guardian_email}}",
    ]),
  },
  {
    code: "cover-letter",
    name: "Cover Letter",
    documentType: "Cover Letter",
    fileName: "cover-letter.pdf",
    version: LETTER_TEMPLATE_VERSION,
    requiredFields: [
      { field: "today_date", label: "Current date" },
      { field: "consulate_name", label: "Consulate name" },
      { field: "consulate_city", label: "Consulate city" },
      { field: "child_name", label: "Applicant name" },
      { field: "passport_no", label: "Passport number" },
      { field: "destination_country", label: "Destination country" },
      { field: "travel_start_date", label: "Travel start date" },
      { field: "travel_end_date", label: "Travel end date" },
      { field: "organizer_name", label: "School or organizer name" },
    ],
    contentHtml: letterContent("Cover Letter", [
      "Date: {{today_date}}",
      "To,",
      "The Visa Officer<br>{{consulate_name}}<br>{{consulate_city}}",
      "Subject: Visa application for {{child_name}}",
      "Dear Sir/Madam,",
      "This letter supports the visa application of {{child_name}}, passport number {{passport_no}}, for travel to {{destination_country}} from {{travel_start_date}} to {{travel_end_date}}.",
      "The trip is coordinated by {{organizer_name}}. The applicant will return after the scheduled travel period and will comply with all visa conditions.",
      "Kindly consider the application and supporting documents.",
      "Thank you for your time and consideration.",
      "Sincerely,",
      "Authorized signatory: {{organizer_name}}<br>Authorized Signatory",
      "Contact: {{guardian_phone}} / {{guardian_email}}",
    ]),
  },
  {
    code: "no-objection-certificate",
    name: "No Objection Certificate",
    documentType: "No Objection Certificate",
    fileName: "no-objection-certificate.pdf",
    version: LETTER_TEMPLATE_VERSION,
    requiredFields: [
      { field: "today_date", label: "Current date" },
      { field: "organizer_name", label: "School or organizer name" },
      { field: "child_name", label: "Student name" },
      { field: "passport_no", label: "Passport number" },
      { field: "destination_country", label: "Destination country" },
      { field: "travel_start_date", label: "Travel start date" },
      { field: "travel_end_date", label: "Travel end date" },
    ],
    contentHtml: letterContent("No Objection Certificate", [
      "Date: {{today_date}}",
      "To,",
      "The Visa Officer<br>{{consulate_name}}<br>{{consulate_city}}",
      "Subject: No objection for travel of {{child_name}}",
      "Dear Sir/Madam,",
      "This is to certify that {{child_name}}, passport number {{passport_no}}, is associated with {{organizer_name}} and has no objection from the institution or organizer to travel to {{destination_country}} from {{travel_start_date}} to {{travel_end_date}}.",
      "The applicant is expected to return after completion of the trip and resume regular commitments.",
      "We kindly request you to consider this certificate in support of the visa application.",
      "Thank you for your time and consideration.",
      "Sincerely,",
      "Authorized signatory: {{organizer_name}}<br>Designation and seal",
      "Contact: {{guardian_phone}} / {{guardian_email}}",
    ]),
  },
  {
    code: "sponsorship-letter",
    name: "Sponsorship Letter",
    documentType: "Sponsorship Letter",
    fileName: "sponsorship-letter.pdf",
    version: LETTER_TEMPLATE_VERSION,
    requiredFields: [
      { field: "today_date", label: "Current date" },
      { field: "father_name", label: "Sponsor name" },
      { field: "child_name", label: "Applicant name" },
      { field: "passport_no", label: "Passport number" },
      { field: "destination_country", label: "Destination country" },
      { field: "travel_start_date", label: "Travel start date" },
      { field: "travel_end_date", label: "Travel end date" },
      { field: "guardian_phone", label: "Sponsor phone" },
      { field: "guardian_email", label: "Sponsor email" },
    ],
    contentHtml: letterContent("Sponsorship Letter", [
      "Date: {{today_date}}",
      "To,",
      "The Visa Officer<br>{{consulate_name}}<br>{{consulate_city}}",
      "Subject: Sponsorship for travel of {{child_name}}",
      "Dear Sir/Madam,",
      "I, {{father_name}}, confirm that I will sponsor {{child_name}}, passport number {{passport_no}}, for travel to {{destination_country}} from {{travel_start_date}} to {{travel_end_date}}.",
      "I undertake responsibility for the applicant's travel, accommodation, meals, insurance, local transport, and any other reasonable expenses during the trip.",
      "We kindly request you to consider this sponsorship letter in support of the visa application.",
      "Thank you for your time and consideration.",
      "Sincerely,",
      "Sponsor signature: {{father_name}}<br>Sponsor",
      "Contact: {{guardian_phone}} / {{guardian_email}}",
    ]),
  },
];

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
}

const BLANK_GUARDIAN_NAME = "..............................";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLineValue(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function splitGuardianNames(value) {
  const raw = text(value);
  if (!raw) return { father: "", mother: "", names: [] };
  const parts = raw.split(/\s+(?:and|&)\s+|,/i).map((p) => text(p)).filter(Boolean);
  if (parts.length >= 2) return { father: parts[0], mother: parts[1], names: parts.slice(0, 2) };
  return { father: raw, mother: raw, names: [raw] };
}

function buildVisaLetterData({
  application,
  contact,
  trip,
  participant,
  schoolContact,
  passportIdentity,
  passportNumberOverride,
}) {
  const guardian = splitGuardianNames(participant?.parentName || contact?.name);
  const destination = text(application?.destinationCountry) || text(trip?.destination);
  const consulateCountry = destination || "Destination Country";
  return {
    today_date: formatDate(new Date()),
    consulate_name: `Consulate General of ${consulateCountry}`,
    consulate_city: "Bengaluru, India",
    father_name: guardian.father,
    mother_name: guardian.names.length >= 2 ? guardian.mother : BLANK_GUARDIAN_NAME,
    child_name: text(participant?.fullName) || text(contact?.name),
    passport_no: text(passportNumberOverride) || text(participant?.passportNumber) || text(passportIdentity?.passportNumber),
    destination_country: destination,
    travel_start_date: formatDate(trip?.departDate),
    travel_end_date: formatDate(trip?.returnDate),
    guardian_phone: text(participant?.parentPhone) || text(contact?.phone),
    guardian_email: text(participant?.parentEmail) || text(contact?.email),
    organizer_name: text(schoolContact?.company) || text(schoolContact?.name) || text(trip?.tripCode) || "Trip organizer",
  };
}

function replaceTemplate(contentHtml, data) {
  return String(contentHtml || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => {
    const value = data[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

function htmlToBlocks(html) {
  const blocks = [];
  const normalized = String(html || "").replace(/<br\s*\/?>/gi, "\n");
  const re = /<(h1|h2|p|li)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = re.exec(normalized))) {
    const kind = match[1].toLowerCase();
    const raw = match[2].replace(/<[^>]+>/g, "").replace(/\s+\n/g, "\n").trim();
    if (!raw) continue;
    blocks.push({ kind, text: kind === "li" ? `- ${raw}` : raw });
  }
  if (blocks.length) return blocks;
  return normalized
    .replace(/<[^>]+>/g, "")
    .split(/\n{2,}/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => ({ kind: i === 0 ? "h1" : "p", text: line }));
}

const LETTER_PAGE = {
  margin: LETTER_STYLES.margin,
  titleColor: LETTER_STYLES.titleColor,
  bodyColor: LETTER_STYLES.bodyColor,
  mutedColor: LETTER_STYLES.mutedColor,
  ruleColor: LETTER_STYLES.lineColor,
};

function extractLetterSections(template, data) {
  const blocks = htmlToBlocks(replaceTemplate(template.contentHtml, data));
  const sections = {
    title: "",
    date: "",
    recipient: [],
    subject: "",
    body: [],
    signatures: [],
    footerContact: "",
  };
  let sawRecipientLabel = false;

  blocks.forEach((block) => {
    const textValue = String(block.text || "").trim();
    if (!textValue) return;

    if (!sections.title && block.kind === "h1") {
      sections.title = textValue.toUpperCase();
      return;
    }

    if (/^date:\s*/i.test(textValue)) {
      sections.date = textValue.replace(/^date:\s*/i, "").trim();
      return;
    }

    if (/^to,?$/i.test(textValue)) {
      sawRecipientLabel = true;
      return;
    }

    if (sawRecipientLabel && sections.recipient.length === 0 && /visa officer|consulate/i.test(textValue)) {
      sections.recipient.push(textValue);
      return;
    }

    if (/^subject:\s*/i.test(textValue)) {
      sections.subject = textValue.replace(/^subject:\s*/i, "").trim();
      return;
    }

    if (/contact:/i.test(textValue)) {
      sections.footerContact = textValue;
      return;
    }

    if (/(signature|seal)/i.test(textValue)) {
      const parts = textValue.split(/\n+/).map((line) => text(line)).filter(Boolean);
      const head = parts.shift() || "";
      const colonIndex = head.indexOf(":");
      const label = colonIndex >= 0 ? head.slice(0, colonIndex).trim() : head.trim();
      const firstLine = colonIndex >= 0 ? head.slice(colonIndex + 1).trim() : "";
      const name = firstLine || parts.shift() || "";
      const role = parts.join(" ").trim();
      sections.signatures.push({
        label,
        name: name || BLANK_GUARDIAN_NAME,
        role,
      });
      return;
    }

    sections.body.push({ kind: block.kind, text: textValue });
  });

  if (!sections.date) sections.date = text(data.today_date);
  if (!sections.recipient.length) {
    sections.recipient = [
      "The Visa Officer",
      text(data.consulate_name),
      text(data.consulate_city),
    ].filter(Boolean);
  }
  if (!sections.subject) sections.subject = template.documentType || template.name || "Visa Letter";
  if (!sections.title) sections.title = template.documentType || template.name || "Visa Letter";
  sections.title = sections.title.toUpperCase();
  return sections;
}

function drawRule(doc, y) {
  const left = LETTER_PAGE.margin;
  const right = doc.page.width - LETTER_PAGE.margin;
  doc.save();
  doc.strokeColor(LETTER_PAGE.ruleColor).lineWidth(0.8);
  doc.moveTo(left, y).lineTo(right, y).stroke();
  doc.restore();
}

function drawHeaderOrnament(doc, y) {
  const left = LETTER_PAGE.margin;
  const right = doc.page.width - LETTER_PAGE.margin;
  const center = (left + right) / 2;
  const gap = 24;
  const halfDiamond = 6;

  doc.save();
  doc.strokeColor(LETTER_PAGE.ruleColor).lineWidth(0.9);
  doc.moveTo(left, y).lineTo(center - gap, y).stroke();
  doc.moveTo(center + gap, y).lineTo(right, y).stroke();
  doc.restore();

  doc.save();
  doc.strokeColor(LETTER_PAGE.ruleColor).lineWidth(0.9);
  doc.moveTo(center, y - halfDiamond)
    .lineTo(center + halfDiamond, y)
    .lineTo(center, y + halfDiamond)
    .lineTo(center - halfDiamond, y)
    .lineTo(center, y - halfDiamond)
    .stroke();
  doc.moveTo(center - 6, y).lineTo(center + 6, y).stroke();
  doc.restore();
}

function parseContactInfo(value, fallbackPhone, fallbackEmail) {
  const raw = normalizeLineValue(value);
  const contactBody = raw.includes(":") ? raw.split(":").slice(1).join(":").trim() : raw;
  const [phonePart, emailPart] = contactBody.split(/\s*\/\s*/);
  return {
    phone: text(phonePart) || text(fallbackPhone),
    email: text(emailPart) || text(fallbackEmail),
  };
}

function drawSignatureBlock(doc, { x, y, width, name, role }) {
  const blockWidth = width;
  const lineY = y + 8;
  const nameY = lineY + 16;
  const roleY = nameY + 20;

  doc.save();
  doc.strokeColor(LETTER_PAGE.ruleColor).lineWidth(0.9);
  doc.moveTo(x, lineY).lineTo(x + blockWidth, lineY).stroke();
  doc.restore();

  doc.font("Times-Bold").fontSize(13).fillColor(LETTER_PAGE.bodyColor);
  doc.text(text(name) || BLANK_GUARDIAN_NAME, x, nameY, { width: blockWidth, align: "left" });
  doc.font("Times-Roman").fontSize(11.25).fillColor(LETTER_PAGE.bodyColor);
  doc.text(text(role), x, roleY, { width: blockWidth, align: "left" });
}

function renderSignatureArea(doc, signatureTexts) {
  const entries = Array.isArray(signatureTexts) && signatureTexts.length > 0
    ? signatureTexts
    : [{ name: BLANK_GUARDIAN_NAME, role: "Signature" }];
  const availableWidth = doc.page.width - (LETTER_PAGE.margin * 2);
  const gap = 40;
  const isDual = entries.length >= 2;
  const columnWidth = isDual ? Math.floor((availableWidth - gap) / 2) : Math.min(240, availableWidth);
  const desiredY = doc.y + 22;
  const footerReserve = 92;
  const signatureBlockHeight = 58;
  const footerTop = doc.page.height - LETTER_PAGE.margin - footerReserve;
  const startY = Math.max(desiredY, footerTop - signatureBlockHeight);

  doc.y = startY;
  doc.x = LETTER_PAGE.margin;

  if (isDual) {
    drawSignatureBlock(doc, {
      x: LETTER_PAGE.margin,
      y: startY,
      width: columnWidth,
      name: entries[0].name,
      role: entries[0].role,
    });
    drawSignatureBlock(doc, {
      x: LETTER_PAGE.margin + columnWidth + gap,
      y: startY,
      width: columnWidth,
      name: entries[1].name,
      role: entries[1].role,
    });
    doc.y = startY + signatureBlockHeight;
    return;
  }

  const singleX = LETTER_PAGE.margin + Math.floor((availableWidth - columnWidth) / 2);
  drawSignatureBlock(doc, {
    x: singleX,
    y: startY,
    width: columnWidth,
    name: entries[0].name,
    role: entries[0].role,
  });
  doc.y = startY + signatureBlockHeight;
}

function drawContactIcon(doc, { x, y, label }) {
  doc.save();
  doc.circle(x, y, 11).fillAndStroke(LETTER_STYLES.iconFill, LETTER_STYLES.iconFill);
  doc.fillColor("#ffffff").font("Times-Bold").fontSize(9.5);
  doc.text(label, x - 4.5, y - 4.5, { width: 9, align: "center" });
  doc.restore();
}

function renderFooter(doc, footerContact) {
  const footerY = doc.page.height - LETTER_PAGE.margin - 52;
  drawRule(doc, footerY);

  const contact = parseContactInfo(
    footerContact,
    text(doc.__visaContactPhone),
    text(doc.__visaContactEmail),
  );
  if (!contact.phone && !contact.email) return;

  const items = [];
  if (contact.phone) items.push({ label: "P", text: contact.phone });
  if (contact.email) items.push({ label: "E", text: contact.email });
  if (!items.length) return;

  const contactFontSize = LETTER_STYLES.footerSize;
  doc.font("Times-Roman").fontSize(contactFontSize).fillColor(LETTER_PAGE.bodyColor);
  const itemGap = 18;
  const separatorGap = 20;
  const itemWidths = items.map((item) => 26 + doc.widthOfString(item.text));
  const totalWidth = itemWidths.reduce((sum, width) => sum + width, 0) + (items.length > 1 ? separatorGap : 0);
  let cursorX = (doc.page.width - totalWidth) / 2;
  const iconY = footerY + 34;
  const textY = footerY + 27;

  items.forEach((item, index) => {
    drawContactIcon(doc, { x: cursorX + 12, y: iconY, label: item.label });
    doc.font("Times-Roman").fontSize(contactFontSize).fillColor(LETTER_PAGE.bodyColor);
    doc.text(item.text, cursorX + 30, textY, { width: itemWidths[index] - 26, align: "left" });
    cursorX += itemWidths[index];
    if (index === 0 && items.length > 1) {
      doc.save();
      doc.strokeColor(LETTER_PAGE.ruleColor).lineWidth(0.8);
      doc.moveTo(cursorX + 8, footerY + 24).lineTo(cursorX + 8, footerY + 46).stroke();
      doc.restore();
      cursorX += separatorGap;
    } else {
      cursorX += itemGap;
    }
  });
}

function renderVisaLetterPdf({ template, data }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: LETTER_PAGE.margin });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    const sections = extractLetterSections(template, data);
    const bodyWidth = doc.page.width - (LETTER_PAGE.margin * 2);

    doc.__visaContactPhone = data.guardian_phone || data.sponsor_phone || data.organizer_phone || "";
    doc.__visaContactEmail = data.guardian_email || data.sponsor_email || data.organizer_email || "";

    doc.font("Times-Bold");
    doc.fillColor(LETTER_PAGE.titleColor);
    doc.fontSize(LETTER_STYLES.titleSize).text(sections.title, {
      align: "center",
      lineGap: 1,
    });
    drawHeaderOrnament(doc, doc.y + 14);
    doc.moveDown(2.0);

    doc.font("Times-Bold").fontSize(LETTER_STYLES.dateSize).fillColor(LETTER_PAGE.bodyColor);
    doc.text(`Date: ${sections.date || text(data.today_date)}`, {
      align: "right",
      width: bodyWidth,
    });
    doc.moveDown(1.35);

    doc.font("Times-Bold").fontSize(LETTER_STYLES.bodySize).fillColor(LETTER_PAGE.bodyColor).text("To,");
    doc.moveDown(0.28);
    doc.font("Times-Roman").fontSize(LETTER_STYLES.bodySize).fillColor(LETTER_PAGE.bodyColor);
    doc.text(sections.recipient.join("\n"), {
      width: bodyWidth,
      lineGap: 5,
      paragraphGap: 2,
    });
    doc.moveDown(0.75);

    doc.font("Times-Bold").fontSize(LETTER_STYLES.subjectSize);
    doc.text(`Subject: ${sections.subject}`, {
      width: bodyWidth,
      lineGap: 3,
    });
    doc.moveDown(0.8);

    doc.font("Times-Roman").fontSize(LETTER_STYLES.bodySize).fillColor(LETTER_PAGE.bodyColor);
    sections.body.forEach((block) => {
      doc.font(block.kind === "h2" ? "Times-Bold" : "Times-Roman");
      doc.text(block.text, {
        width: bodyWidth,
        align: "left",
        lineGap: 5,
        paragraphGap: 8,
      });
      doc.moveDown(block.kind === "h2" ? 0.5 : 0.6);
    });

    renderSignatureArea(doc, sections.signatures);
    renderFooter(doc, sections.footerContact);
    doc.end();
  });
}

function parseRequiredFields(template) {
  try {
    const fields = JSON.parse(template.requiredFieldsJson || "[]");
    return Array.isArray(fields) ? fields : [];
  } catch {
    return [];
  }
}

function validateTemplateData(template, data) {
  return parseRequiredFields(template).filter((f) => !text(data[f.field]));
}

async function ensureDefaultVisaLetterTemplates(prisma, tenantId, actorUserId) {
  const delegate = prisma.visaLetterTemplate;
  if (!delegate) return [];
  const existing = await delegate.findMany({
    where: { tenantId, isActive: true },
    orderBy: [{ code: "asc" }, { version: "desc" }],
    select: { code: true, version: true },
  });
  const latestVersionByCode = new Map();
  existing.forEach((row) => {
    const current = latestVersionByCode.get(row.code) || 0;
    if (Number(row.version) > current) latestVersionByCode.set(row.code, Number(row.version) || 0);
  });
  for (const template of DEFAULT_LETTER_TEMPLATES) {
    const latestVersion = latestVersionByCode.get(template.code) || 0;
    if (latestVersion >= template.version) continue;
    await delegate.create({
      data: {
        tenantId,
        code: template.code,
        name: template.name,
        documentType: template.documentType,
        version: template.version,
        contentHtml: template.contentHtml,
        requiredFieldsJson: JSON.stringify(template.requiredFields),
        createdById: actorUserId || null,
        isActive: true,
      },
    });
  }
}

async function loadActiveTemplates(prisma, tenantId, actorUserId) {
  await ensureDefaultVisaLetterTemplates(prisma, tenantId, actorUserId);
  const rows = await prisma.visaLetterTemplate.findMany({
    where: { tenantId, isActive: true },
    orderBy: [{ code: "asc" }, { version: "desc" }],
  });
  const byCode = new Map();
  rows.forEach((row) => {
    if (!byCode.has(row.code)) byCode.set(row.code, row);
  });
  return DEFAULT_LETTER_TEMPLATES.map((base) => byCode.get(base.code)).filter(Boolean);
}

function projectLetterDocument(doc) {
  if (!doc) return null;
  return {
    id: doc.id,
    generationId: doc.generationId,
    visaApplicationId: doc.visaApplicationId,
    tripId: doc.tripId,
    participantId: doc.participantId,
    templateCode: doc.templateCode,
    templateVersion: doc.templateVersion,
    documentType: doc.documentType,
    docType: doc.documentType,
    status: doc.status,
    generatedFileName: doc.generatedFileName,
    signedFileName: doc.signedFileName || null,
    generatedAt: doc.generatedAt,
    sentAt: doc.sentAt || null,
    signedUploadedAt: doc.signedUploadedAt || null,
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_v, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(dateValue) {
  const d = dateValue ? new Date(dateValue) : new Date();
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function makeZipBuffer(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  entries.forEach((entry) => {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.buffer) ? entry.buffer : Buffer.from(entry.buffer || "");
    const crc = crc32(data);
    const dt = dosDateTime(entry.date);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dt.time, 10);
    local.writeUInt16LE(dt.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dt.time, 12);
    central.writeUInt16LE(dt.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  });
  const centralStart = offset;
  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

module.exports = {
  DEFAULT_LETTER_TEMPLATES,
  buildVisaLetterData,
  formatDate,
  loadActiveTemplates,
  makeZipBuffer,
  projectLetterDocument,
  renderVisaLetterPdf,
  validateTemplateData,
};
