const MAX_CUSTOM_CSS_LENGTH = 20000;
const csstree = require("css-tree");
// Rebuild the iframe copy after edits:
// frontend/node_modules/.bin/esbuild backend/lib/webFormCustomCss.js --bundle
// --platform=browser --format=iife --global-name=gbsCustomCss --minify
// --outfile=frontend/public/embed/web-form-custom-css.js

/**
 * Custom CSS is rendered in the form's isolated iframe. Keep the feature
 * focused on presentation rules and prevent external resource loads or
 * legacy script-like CSS constructs from being persisted.
 */
function sanitizeCustomCss(value) {
  const css = String(value == null ? "" : value).slice(0, MAX_CUSTOM_CSS_LENGTH);

  // Parse CSS before inspecting it so valid syntax such as child combinators,
  // comments, and escaped identifiers is handled by the CSS parser rather
  // than rejected by a raw-text heuristic. Unsafe resource-loading constructs
  // are removed from the parsed AST below.
  try {
    const ast = csstree.parse(css, {
      positions: false, parseCustomProperty: true,
      onParseError(error) { throw error; },
    });
    csstree.walk(ast, {
      visit: "Atrule",
      enter(node, item, list) {
        if (!["media", "supports", "container", "layer", "keyframes", "-webkit-keyframes"].includes(node.name.toLowerCase())) {
          list.remove(item);
          return csstree.walk.skip;
        }
      },
    });
    csstree.walk(ast, {
      visit: "Declaration",
      enter(node, item, list) {
        let unsafe = /^(?:behavior|-moz-binding)$/i.test(node.property)
          || node.value.children?.isEmpty;
        csstree.walk(node.value, (value) => {
          if (value.type === "Raw" || value.type === "Url"
            || (value.type === "Function" && /^(?:url|image|image-set|-webkit-image-set|src|expression|paint)$/i.test(value.name))) unsafe = true;
        });
        if (unsafe) list.remove(item);
      },
    });
    return csstree.generate(ast);
  } catch (_error) {
    // Never persist partially parsed or malformed CSS.
    return "";
  }
}

module.exports = {
  MAX_CUSTOM_CSS_LENGTH,
  sanitizeCustomCss,
};
