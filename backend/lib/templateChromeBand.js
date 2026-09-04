"use strict";

// Finds the band of a template page that is SAFE TO ERASE.
//
// The renderer has to white out the uploaded template's own example content
// before drawing a real trip over it. It used to do that using the analyser's
// detected content box — but that box is derived from text positions and
// deliberately treats anything near the top as chrome, so a template whose
// example content starts high (its own "Itinerary" heading, a black
// TIME | ACTIVITY table header) had those elements sitting ABOVE the box and
// they survived into the customer's document. Worse, a template with no
// detected box at all fell back to a fixed 12%/86% guess, which cleared even
// less.
//
// Brochure pages are almost always ruled: a horizontal line under the
// letterhead and another above the footer. Those two rules ARE the chrome
// boundary, and unlike text positions they are unambiguous. This finds them by
// rasterising the page and looking for thin, near-full-width, dark rows with
// white directly above and below — which is what a rule is and what a heading,
// a table bar or a photo is not.
//
// Returns null for a page with no detectable rules, and the caller keeps its
// previous behaviour. Nothing here guesses: no rules found, no claim made.

const { pdfBufferToImageParts } = require("./pdfToImages");

const SCALE = 1;
// A rule spans most of the text column. 0.55 clears a centred rule that stops
// short of the margins without matching a two-column table row.
const MIN_RUN_FRACTION = 0.55;
// "Ink" means "not paper", not "dark". The first version tested every channel
// against a dark threshold, which silently missed the very rules it was built
// to find: this brand's header rule is cyan (r22 g188 b212), so its blue
// channel sat above any dark cutoff and the rule scanned as blank paper.
// Distance from white is the property that actually matters.
const PAPER_MIN_CHANNEL = 200;
// A rule is thin. A black table header band is 15pt+, so this is what keeps
// the two apart.
const MAX_RULE_THICKNESS_PX = 6;
// Clear space required immediately outside the rule, proving it is a rule and
// not the top edge of a filled block.
const CLEARANCE_PX = 4;
const CLEAR_ROW_FRACTION = 0.9;

function rowStats(data, width, y, channels) {
  let ink = 0;
  for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * channels;
    const darkest = Math.min(data[i], data[i + 1], data[i + 2]);
    if (darkest < PAPER_MIN_CHANNEL) ink += 1;
  }
  return ink / width;
}

// Collect thin dark bands that have clear space on both sides.
function findRules(data, width, height, channels) {
  const dense = [];
  for (let y = 0; y < height; y += 1) {
    dense.push(rowStats(data, width, y, channels) >= MIN_RUN_FRACTION);
  }

  const rules = [];
  let y = 0;
  while (y < height) {
    if (!dense[y]) { y += 1; continue; }
    let end = y;
    while (end + 1 < height && dense[end + 1]) end += 1;
    const thickness = end - y + 1;
    if (thickness <= MAX_RULE_THICKNESS_PX) {
      const above = y - CLEARANCE_PX;
      const below = end + CLEARANCE_PX;
      const clearAbove = above < 0 || rowStats(data, width, above, channels) <= 1 - CLEAR_ROW_FRACTION;
      const clearBelow = below >= height || rowStats(data, width, below, channels) <= 1 - CLEAR_ROW_FRACTION;
      if (clearAbove && clearBelow) rules.push({ top: y, bottom: end });
    }
    y = end + 1;
  }
  return rules;
}

/**
 * @param {Buffer} pdfBuffer            the template's source PDF
 * @param {Array<{width:number,height:number}>} pageSizes  PDF-point sizes
 * @returns {Promise<Array<{contentTop:number, contentBottom:number}|null>>}
 *   One entry per page, in PDF points (y grows upward), or null where no
 *   rules were found.
 */
async function detectChromeBands(pdfBuffer, pageSizes) {
  let images;
  try {
    images = await pdfBufferToImageParts(pdfBuffer, { maxPages: pageSizes.length, scale: SCALE });
  } catch (err) {
    console.warn("[templateChromeBand] could not rasterise the template:", err.message);
    return pageSizes.map(() => null);
  }
  if (!images.length) return pageSizes.map(() => null);

  let sharp;
  try {
    sharp = require("sharp");
  } catch (err) {
    console.warn("[templateChromeBand] sharp unavailable:", err.message);
    return pageSizes.map(() => null);
  }

  // Collect every candidate rule per page first. Picking per page in
  // isolation was wrong: on an interior page the lowest rule in the top third
  // is often part of the example TABLE, not the letterhead, which dragged the
  // erase ceiling hundreds of points down the page.
  //
  // Chrome is the thing that REPEATS. So gather candidates from all pages and
  // take the position that appears on the most of them — that is the
  // letterhead rule by definition, and a rule belonging to one page's sample
  // content cannot outvote it.
  const perPage = [];
  for (let i = 0; i < pageSizes.length; i += 1) {
    const img = images[i];
    if (!img) { perPage.push(null); continue; }
    try {
      const { data, info } = await sharp(Buffer.from(img.data, "base64"))
        .raw()
        .toBuffer({ resolveWithObject: true });
      const { width, height, channels } = info;
      const pageH = pageSizes[i].height;
      const pxToPdfY = (px) => pageH - (px / height) * pageH;
      perPage.push({
        height,
        pxToPdfY,
        rules: findRules(data, width, height, channels),
      });
    } catch (err) {
      console.warn(`[templateChromeBand] page ${i + 1} scan failed:`, err.message);
      perPage.push(null);
    }
  }

  const vote = (values) => {
    const counts = new Map();
    for (const v of values) {
      const key = Math.round(v);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let best = null;
    let bestCount = 0;
    for (const [key, count] of counts) {
      if (count > bestCount || (count === bestCount && best !== null && key > best)) {
        best = key;
        bestCount = count;
      }
    }
    return { value: best, count: bestCount };
  };

  const headerYs = [];
  const footerYs = [];
  for (const page of perPage) {
    if (!page) continue;
    for (const r of page.rules) {
      if (r.bottom < page.height * 0.34) headerYs.push(page.pxToPdfY(r.bottom));
      if (r.top > page.height * 0.8) footerYs.push(page.pxToPdfY(r.top));
    }
  }

  const header = vote(headerYs);
  const footer = vote(footerYs);
  // A rule that shows up on only one page of a multi-page template is that
  // page's own content, not chrome — refuse to build a band from it.
  const minVotes = perPage.filter(Boolean).length > 1 ? 2 : 1;
  const contentTop = header.count >= minVotes && header.value !== null ? header.value - 2 : null;
  const contentBottom = footer.count >= minVotes && footer.value !== null ? footer.value + 2 : null;

  if (contentTop === null && contentBottom === null) return pageSizes.map(() => null);
  return pageSizes.map((_size, i) => (perPage[i] ? { contentTop, contentBottom } : null));
}

module.exports = { detectChromeBands, findRules };
