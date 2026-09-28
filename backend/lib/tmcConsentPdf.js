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
};
