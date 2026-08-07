const PDF_IMAGE_WIDTH = 1200;
const PDF_IMAGE_HEIGHT = 1437;
const PDF_PAGE_WIDTH = 595;
const PDF_PAGE_HEIGHT = 842;
const PDF_PAGE_MARGIN = 28;
const textEncoder = new TextEncoder();

function encodeAscii(text) {
  return textEncoder.encode(String(text));
}

function concatBytes(chunks) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function buildSingleImagePdfBytes(
  imageBytes,
  imageWidth = PDF_IMAGE_WIDTH,
  imageHeight = PDF_IMAGE_HEIGHT,
  pageWidth = PDF_PAGE_WIDTH,
  pageHeight = PDF_PAGE_HEIGHT,
  margin = PDF_PAGE_MARGIN,
) {
  if (!(imageBytes instanceof Uint8Array) || imageBytes.length === 0) {
    throw new Error("imageBytes are required to build the PDF");
  }

  const offsets = { 0: 0 };
  const parts = [];
  let position = 0;
  const push = (chunk) => {
    const bytes = typeof chunk === "string" ? encodeAscii(chunk) : chunk;
    parts.push(bytes);
    position += bytes.length;
    return bytes;
  };
  const pushObject = (id, body) => {
    offsets[id] = position;
    push(`${id} 0 obj\n${body}\nendobj\n`);
  };

  const availableWidth = Math.max(1, pageWidth - margin * 2);
  const availableHeight = Math.max(1, pageHeight - margin * 2);
  const scale = Math.min(availableWidth / imageWidth, availableHeight / imageHeight);
  const drawWidth = Math.round(imageWidth * scale * 1000) / 1000;
  const drawHeight = Math.round(imageHeight * scale * 1000) / 1000;
  const offsetX = Math.round(((pageWidth - drawWidth) / 2) * 1000) / 1000;
  const offsetY = Math.round(((pageHeight - drawHeight) / 2) * 1000) / 1000;
  const contentStream = `q\n${drawWidth} 0 0 ${drawHeight} ${offsetX} ${offsetY} cm\n/Im0 Do\nQ\n`;

  push("%PDF-1.4\n");
  pushObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
  pushObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  pushObject(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
  );
  offsets[4] = position;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBytes.length} >>\nstream\n`);
  push(imageBytes);
  push("\nendstream\nendobj\n");
  pushObject(5, `<< /Length ${encodeAscii(contentStream).length} >>\nstream\n${contentStream}endstream`);

  const xrefOffset = position;
  const xref = encodeAscii([
    "xref\n",
    "0 6\n",
    "0000000000 65535 f \n",
    ...[1, 2, 3, 4, 5].map((id) => `${String(offsets[id] || 0).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join(""));

  return concatBytes([...parts, xref]);
}

async function loadImageFromObjectUrl(objectUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load SVG for PDF export"));
    image.src = objectUrl;
  });
}

async function canvasToJpegBytes(canvas) {
  const blob = await new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== "function") {
      reject(new Error("Canvas export is not supported in this browser"));
      return;
    }
    canvas.toBlob((result) => {
      if (!result) {
        reject(new Error("Failed to encode the PDF image"));
        return;
      }
      resolve(result);
    }, "image/jpeg", 0.98);
  });
  return new Uint8Array(await blob.arrayBuffer());
}

export async function buildFlightOfferPdfBlob(svgMarkup, { pageWidth = PDF_PAGE_WIDTH, pageHeight = PDF_PAGE_HEIGHT } = {}) {
  if (!svgMarkup) {
    throw new Error("svgMarkup is required to build the PDF");
  }

  const svgBlob = new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
  const objectUrl = URL.createObjectURL(svgBlob);
  try {
    const image = await loadImageFromObjectUrl(objectUrl);
    const canvas = document.createElement("canvas");
    canvas.width = PDF_IMAGE_WIDTH;
    canvas.height = PDF_IMAGE_HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas rendering is not supported in this browser");
    }
    context.drawImage(image, 0, 0, PDF_IMAGE_WIDTH, PDF_IMAGE_HEIGHT);
    const imageBytes = await canvasToJpegBytes(canvas);
    const pdfBytes = buildSingleImagePdfBytes(imageBytes, PDF_IMAGE_WIDTH, PDF_IMAGE_HEIGHT, pageWidth, pageHeight);
    return new Blob([pdfBytes], { type: "application/pdf" });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export { PDF_PAGE_WIDTH as FLIGHT_OFFER_PDF_WIDTH, PDF_PAGE_HEIGHT as FLIGHT_OFFER_PDF_HEIGHT };
