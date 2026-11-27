const sanitizeHtml = require("sanitize-html");
const { extractKeyFromUrl, isLocalUrl } = require("../services/s3Service");

const MAX_ENCODED_RICH_TEXT_BYTES = 512 * 1024;

function isStoredImageUrl(value) {
  const src = String(value || "");
  return isLocalUrl(src) || Boolean(extractKeyFromUrl(src));
}

function decodeGenericRichText(encoded) {
  const value = String(encoded || "");
  if (!value || value.length > MAX_ENCODED_RICH_TEXT_BYTES) return null;
  let decoded;
  try {
    decoded = Buffer.from(value, "base64").toString("utf8");
  } catch (_error) {
    return null;
  }

  return sanitizeHtml(decoded, {
    allowedTags: [
      "a", "b", "blockquote", "br", "del", "div", "em", "font", "i",
      "img", "li", "ol", "p", "s", "span", "strike", "strong", "sub",
      "sup", "u", "ul",
    ],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt"],
      font: ["size"],
      "*": ["style"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https"] },
    allowProtocolRelative: false,
    allowedStyles: {
      "*": {
        "font-style": [/^(?:normal|italic)$/],
        "font-weight": [/^(?:normal|bold|400|500|600|700)$/],
        "text-align": [/^(?:left|center|right|justify)$/],
        "text-decoration": [/^(?:none|underline|line-through)$/],
      },
    },
    exclusiveFilter(frame) {
      return frame.tag === "img" && !isStoredImageUrl(frame.attribs?.src);
    },
  });
}

module.exports = { decodeGenericRichText, MAX_ENCODED_RICH_TEXT_BYTES };
