const zlib = require("zlib");
const PDFDocument = require("pdfkit");

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF_MIME_TYPE = "application/pdf";
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;

function isPdfBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

function isDocxTemplate(template) {
  return template?.mimeType === DOCX_MIME_TYPE || /\.docx$/i.test(String(template?.filename || ""));
}

function pdfFilename(filename) {
  const safeName = String(filename || "consent-terms").replace(/[\r\n"]/g, "");
  return safeName.replace(/\.[^.]+$/, "") + ".pdf";
}

function findZipEntry(buffer, entryName) {
  const endOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endOffset < 0 || endOffset + 22 > buffer.length) {
    throw new Error("Invalid DOCX archive: end of central directory not found");
  }
  const centralDirectorySize = buffer.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(endOffset + 16);
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  let offset = centralDirectoryOffset;

  while (offset < centralDirectoryEnd) {
    if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("Invalid DOCX archive: central directory entry is malformed");
    }
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const filenameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + filenameLength).toString("utf8");

    if (name === entryName) {
      if (buffer.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_SIGNATURE) {
        throw new Error("Invalid DOCX archive: local file header is malformed");
      }
      const localFilenameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataOffset = localHeaderOffset + 30 + localFilenameLength + localExtraLength;
      const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
      if (compressionMethod === 0) return compressed;
      if (compressionMethod === 8) return zlib.inflateRawSync(compressed);
      throw new Error(`Unsupported DOCX compression method: ${compressionMethod}`);
    }

    offset += 46 + filenameLength + extraLength + commentLength;
  }

  throw new Error(`DOCX entry not found: ${entryName}`);
}

function decodeXmlText(value) {
  return String(value || "").replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code) => {
    if (code.toLowerCase() === "amp") return "&";
    if (code.toLowerCase() === "lt") return "<";
    if (code.toLowerCase() === "gt") return ">";
    if (code.toLowerCase() === "quot") return '"';
    if (code.toLowerCase() === "apos") return "'";
    const numeric = code[0].toLowerCase() === "x"
      ? Number.parseInt(code.slice(1), 16)
      : Number.parseInt(code.slice(1), 10);
    return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : entity;
  });
}

function extractDocxParagraphs(docxBuffer) {
  const xml = findZipEntry(docxBuffer, "word/document.xml").toString("utf8");
  return [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)]
    .map(([, paragraph]) => {
      const withBreaks = paragraph
        .replace(/<w:(?:br|cr)\b[^>]*\/?\s*>/g, "\n")
        .replace(/<w:tab\b[^>]*\/?\s*>/g, "\t");
      const text = [...withBreaks.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
        .map(([, value]) => decodeXmlText(value))
        .join("")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
      return text;
    })
    .filter(Boolean);
}

function pdfSafeText(value) {
  // PDFKit's standard fonts do not contain every Unicode glyph present in
  // Word documents. Keep common whitespace and Latin-1 text readable and
  // replace unsupported glyphs rather than failing the entire download.
  return String(value || "").replace(/[^\u0020-\u00ff]/g, " ");
}

function renderTextAsPdf(paragraphs) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: "A4", margin: 54, bufferPages: true });
    const chunks = [];
    document.on("data", (chunk) => chunks.push(chunk));
    document.once("error", reject);
    document.once("end", () => resolve(Buffer.concat(chunks)));

    document.font("Helvetica").fontSize(10).fillColor("#172033");
    paragraphs.forEach((paragraph, index) => {
      if (index > 0) document.moveDown(0.45);
      document.text(pdfSafeText(paragraph), { align: "justify", lineGap: 2 });
    });
    document.end();
  });
}

function parseDigitalConsentAnswers(value) {
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_err) {
    return {};
  }
}

function parseDigitalConsentTerms(value) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return { title: "", introduction: "", sections: [] };

  const chunks = normalized.split(/(?=\b\d+\.\s+[A-Z])/g).filter(Boolean);
  const opening = chunks.shift() || normalized;
  const titleMatch = opening.match(/^(.+?)(?=\s+These Terms)/i);
  const titleOnlyMatch = opening.match(/^(TERMS AND CONDITIONS(?: FOR)?[A-Z0-9 &'()/,-]*?)\s*$/);
  const title = titleMatch ? titleMatch[1].trim() : (titleOnlyMatch ? titleOnlyMatch[1].trim() : "");
  const introduction = title
    ? opening.slice(titleMatch ? titleMatch[0].length : title.length).trim()
    : opening.trim();

  const sections = chunks.map((chunk) => {
    const headingMatch = chunk.match(/^(\d+\.\s+[A-Z][A-Z0-9 &'(),-]*?)(?=\s+(?:[A-Z][a-z]|[A-Z]\.))/);
    const heading = headingMatch ? headingMatch[1].trim() : "";
    const body = heading ? chunk.slice(headingMatch[0].length).trim() : chunk.trim();
    const paragraphs = body.split(/(?=\b[A-Z]\.\s)/g).map((paragraph) => paragraph.trim()).filter(Boolean);
    return { heading, paragraphs: paragraphs.length ? paragraphs : (body ? [body] : []) };
  });

  return { title, introduction, sections };
}

function renderTmcDigitalConsentPdf(consent) {
  const answers = parseDigitalConsentAnswers(consent?.answersJson);
  const fields = [
    ["Parent or guardian full name", answers.parentName],
    ["Student / participant full name", answers.participantName],
    ["Relationship to the student", answers.relationship],
    ["Signature", answers.signatureName || consent?.signatureName],
    ["Additional notes", answers.notes],
  ];

  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: "A4", margin: 54, bufferPages: true });
    const chunks = [];
    document.on("data", (chunk) => chunks.push(chunk));
    document.once("error", reject);
    document.once("end", () => resolve(Buffer.concat(chunks)));

    document.font("Helvetica-Bold").fontSize(18).fillColor("#122647")
      .text(pdfSafeText(consent?.documentType || "Digital consent form"));
    document.moveDown(0.35).font("Helvetica").fontSize(10).fillColor("#66758a")
      .text(pdfSafeText(`Submitted ${consent?.agreedAt || consent?.uploadedAt || ""}`));
    if (consent?.tripId) document.text(pdfSafeText(`Trip reference: ${consent.tripId}`));

    const terms = parseDigitalConsentTerms(consent?.termsSnapshot);
    document.moveDown(1).font("Helvetica-Bold").fontSize(9).fillColor("#008f66")
      .text("STEP 1  ·  TERMS ACCEPTED");
    document.moveDown(0.25).font("Helvetica-Bold").fontSize(13).fillColor("#122647")
      .text("Terms and conditions");
    document.moveDown(0.2).font("Helvetica").fontSize(9.5).fillColor("#66758a")
      .text("The exact terms accepted by the parent at the time of submission.");
    if (terms.title) {
      document.moveDown(0.65).font("Helvetica-Bold").fontSize(9.5).fillColor("#122647")
        .text(pdfSafeText(terms.title), { lineGap: 2 });
    }
    if (terms.introduction) {
      document.moveDown(0.2).font("Helvetica").fontSize(9.5).fillColor("#172033")
        .text(pdfSafeText(terms.introduction), { lineGap: 2 });
    }
    if (!terms.title && !terms.introduction && !terms.sections.length) {
      document.moveDown(0.65).font("Helvetica").fontSize(9.5).fillColor("#66758a")
        .text("No terms were recorded with this submission.");
    }
    terms.sections.forEach((section) => {
      if (section.heading) {
        document.moveDown(0.65).font("Helvetica-Bold").fontSize(9.5).fillColor("#122647")
          .text(pdfSafeText(section.heading), { lineGap: 2 });
      }
      section.paragraphs.forEach((paragraph) => {
        document.moveDown(section.heading ? 0.2 : 0.65).font("Helvetica").fontSize(9.5).fillColor("#172033")
          .text(pdfSafeText(paragraph), { lineGap: 2 });
      });
    });

    document.moveDown(1).font("Helvetica-Bold").fontSize(9).fillColor("#008f66")
      .text("STEP 2  ·  SUBMITTED DETAILS");
    document.moveDown(0.25).font("Helvetica-Bold").fontSize(13).fillColor("#122647")
      .text("Submitted details");
    document.moveDown(0.2).font("Helvetica").fontSize(9.5).fillColor("#66758a")
      .text("Information provided and signed by the parent or guardian.");
    fields.forEach(([label, value]) => {
      if (!String(value || "").trim()) return;
      document.moveDown(0.55).font("Helvetica-Bold").fontSize(9.5).fillColor("#33445d")
        .text(pdfSafeText(label));
      document.moveDown(0.15).font("Helvetica").fontSize(10).fillColor("#172033")
        .text(pdfSafeText(value), { lineGap: 2 });
    });

    document.moveDown(1).font("Helvetica-Bold").fontSize(10).fillColor("#008f66")
      .text("Agreement: Accepted");
    document.end();
  });
}

async function convertTmcConsentTemplateToPdf(template) {
  const fileBlob = Buffer.isBuffer(template?.fileBlob) ? template.fileBlob : Buffer.from(template?.fileBlob || []);
  if (isPdfBuffer(fileBlob) || template?.mimeType === PDF_MIME_TYPE) {
    return { buffer: fileBlob, filename: pdfFilename(template?.filename), mimeType: PDF_MIME_TYPE };
  }
  if (!isDocxTemplate(template)) {
    throw new Error("Consent template must be a PDF or DOCX file");
  }
  const paragraphs = extractDocxParagraphs(fileBlob);
  if (!paragraphs.length) throw new Error("Consent DOCX contains no readable paragraphs");
  return {
    buffer: await renderTextAsPdf(paragraphs),
    filename: pdfFilename(template?.filename),
    mimeType: PDF_MIME_TYPE,
  };
}

module.exports = {
  DOCX_MIME_TYPE,
  PDF_MIME_TYPE,
  convertTmcConsentTemplateToPdf,
  extractDocxParagraphs,
  isPdfBuffer,
  pdfFilename,
  parseDigitalConsentTerms,
  renderTmcDigitalConsentPdf,
};
