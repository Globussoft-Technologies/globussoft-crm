// @ts-check
/**
 * Travel CRM — PDF itinerary template processor (G115).
 *
 * Converts an uploaded reference PDF into a blank brand template that keeps
 * header / footer / side-branding elements while wiping the variable content
 * area so the rendered itinerary can be overlaid on top.
 *
 * Exported functions:
 *   analyzePdfTemplate(pdfBuffer) -> { blankedBuffer, regions }
 */

const pdfjs = require("pdfjs-dist");
const { PDFDocument, rgb } = require("pdf-lib");

// pdfjs-dist is used in the main Node process, not a browser worker.
pdfjs.GlobalWorkerOptions.disableWorker = true;

const WHITE = rgb(1, 1, 1);

/**
 * Detect the content box for a single page given its text items.
 *
 * Strategy: keep a header band, footer band, and thin side margins as part of
 * the template. Everything in between is variable content and should be
 * blanked. We use pdfjs-dist text positions to find where the header ends and
 * where the footer begins, falling back to safe defaults when the page has no
 * text.
 *
 * @param {Array<{ transform: number[], width: number, height?: number }>} textItems
 * @param {number} pageWidth
 * @param {number} pageHeight
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function detectContentBox(textItems, pageWidth, pageHeight) {
  // PDF coordinate system: origin at bottom-left, y grows upward.
  const boxes = textItems
    .filter((item) => item.str && item.str.trim().length > 0)
    .map((item) => {
      const tx = item.transform;
      const x = tx[4];
      // pdfjs uses the same bottom-left origin for text transforms as PDF does.
      const y = tx[5];
      const width = item.width || 0;
      const height = item.height || 0;
      return { x, y, width, height, top: y + height };
    });

  // Side margin: keep only a thin left strip for edge branding (e.g. the cyan
  // side bar). Everything else — including any right-side ticks, images, or
  // body text — is treated as variable content and blanked.
  const leftMargin = Math.min(30, pageWidth * 0.05);
  const rightMargin = 0;

  // Header band: text in the top 15% of the page is considered header.
  const headerThreshold = pageHeight * 0.15;
  const headerTexts = boxes.filter((b) => b.top > pageHeight - headerThreshold);
  let headerBottom = pageHeight - headerThreshold;
  if (headerTexts.length > 0) {
    // Lowest header text determines the bottom of the header band.
    const lowest = Math.min(...headerTexts.map((b) => b.y));
    headerBottom = Math.max(lowest - 50, headerBottom);
    // Clamp so the header band never exceeds 25% of the page height.
    headerBottom = Math.max(headerBottom, pageHeight * 0.75);
  } else {
    // No header text detected; shrink the header band to a safe default.
    headerBottom = pageHeight * 0.88;
  }

  // Footer band: text in the bottom 12% of the page is considered footer.
  const footerThreshold = pageHeight * 0.12;
  const footerTexts = boxes.filter((b) => b.y < footerThreshold);
  let footerTop = footerThreshold;
  if (footerTexts.length > 0) {
    const highest = Math.max(...footerTexts.map((b) => b.top));
    footerTop = Math.min(highest + 10, footerTop);
    footerTop = Math.max(footerTop, 0);
  } else {
    footerTop = pageHeight * 0.10;
  }

  return {
    x: leftMargin,
    y: footerTop,
    width: pageWidth - leftMargin - rightMargin,
    height: headerBottom - footerTop,
  };
}

/**
 * Analyze a reference PDF and produce a blanked brand template plus the regions
 * where dynamic content should be placed.
 *
 * @param {Buffer|Uint8Array} pdfBuffer
 * @returns {Promise<{ blankedBuffer: Buffer, regions: object }>}
 */
async function analyzePdfTemplate(pdfBuffer) {
  const input = Buffer.isBuffer(pdfBuffer)
    ? new Uint8Array(pdfBuffer)
    : pdfBuffer;
  // pdfjs may consume the input as a stream, so copy before passing it around.
  const inputCopy = new Uint8Array(input);

  const pdfjsDoc = await pdfjs.getDocument({ data: input }).promise;
  const pdfLibDoc = await PDFDocument.load(inputCopy);
  const pages = pdfLibDoc.getPages();

  const pageRegions = [];

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const { width, height } = page.getSize();

    const pdfjsPage = await pdfjsDoc.getPage(i + 1);
    const textContent = await pdfjsPage.getTextContent();
    const contentBox = detectContentBox(textContent.items, width, height);

    pageRegions.push({ page: i + 1, contentBox });

    // Blank the content box with a white rectangle.
    page.drawRectangle({
      x: contentBox.x,
      y: contentBox.y,
      width: contentBox.width,
      height: contentBox.height,
      color: WHITE,
      borderColor: WHITE,
      borderWidth: 0,
    });
  }

  const blankedBuffer = Buffer.from(await pdfLibDoc.save());

  const fallbackPageSize = pages.length > 0 ? pages[0].getSize() : { width: 595.28, height: 841.89 };
  const first = pageRegions[0] || {
    contentBox: {
      x: 30,
      y: fallbackPageSize.height * 0.10,
      width: fallbackPageSize.width - 30,
      height: fallbackPageSize.height * 0.75,
    },
  };

  const regions = {
    pageSize: fallbackPageSize,
    contentBox: first.contentBox,
    pages: pageRegions,
    // Legacy keys for any renderer that still expects them.
    header: { x: 50, y: 770, width: 495, height: 50 },
    customer: { x: 50, y: 690, width: 495, height: 60 },
    tripSummary: { x: 50, y: 620, width: 495, height: 50 },
    items: { x: 50, y: 330, width: 495, height: 270 },
    totals: { x: 50, y: 220, width: 495, height: 90 },
    footer: { x: 50, y: 50, width: 495, height: 50 },
  };

  return { blankedBuffer, regions };
}

module.exports = {
  analyzePdfTemplate,
  detectContentBox,
};
