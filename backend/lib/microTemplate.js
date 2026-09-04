"use strict";

// microTemplate — a deliberately tiny logic-less template renderer.
//
// Exists so an itinerary PDF template can be stored as real HTML/CSS that a
// human (or an AI drafting from a page image) can write and edit directly,
// instead of being squeezed into a fixed enum of layout knobs. The syntax is
// the familiar Mustache/Handlebars subset and NOTHING more — no expressions,
// no helpers, no partials, no property calls. That is a feature: these
// templates are authored by an LLM and edited by non-engineers, so the
// worst a malformed one can do is render badly, never execute anything.
//
// Supported:
//   {{ path }}          escaped interpolation
//   {{{ path }}}        raw interpolation (caller must have sanitized it)
//   {{#each path}}…{{/each}}      arrays; {{this}}, {{@index}}, {{@first}}, {{@last}}
//   {{#if path}}…{{else}}…{{/if}} truthiness (empty array/string are falsey)
//   {{#unless path}}…{{/unless}}
//
// A `path` is dot-separated (`day.title`), or `this`/`.` for the current
// scope. Lookups walk OUT through enclosing scopes like Handlebars, so a
// day loop can still reach top-level `{{accent}}`.
//
// No dependency was added for this: the repo has no templating engine, and
// pulling one in for a ~120-line need would have been the larger change.

const TOKEN_RE = new RegExp(
  [
    /\{\{\{\s*([\w.@]+)\s*\}\}\}/.source, // 1: raw
    /\{\{\s*(#each|#if|#unless)\s+([\w.@]+)\s*\}\}/.source, // 2: open, 3: path
    /\{\{\s*(\/each|\/if|\/unless)\s*\}\}/.source, // 4: close
    /\{\{\s*(else)\s*\}\}/.source, // 5: else
    /\{\{\s*([\w.@]+)\s*\}\}/.source, // 6: escaped
  ].join("|"),
  "g",
);

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Parse into a node tree. Unbalanced blocks throw — the caller treats a throw
// as "this template is broken, fall back", which is far safer than silently
// rendering half a page.
function parse(template) {
  const root = { type: "root", children: [] };
  const stack = [root];
  // After {{else}} a block collects into `alt` instead of `children`; every
  // push goes through here so that switch applies to text, vars and nested
  // blocks alike (an earlier version only flipped a flag and kept appending
  // to `children`, so else-branches rendered in BOTH cases).
  const childrenOf = (node) => (node.inAlt ? node.alt : node.children);
  let last = 0;
  const src = String(template == null ? "" : template);

  const pushText = (text) => {
    if (text) childrenOf(stack[stack.length - 1]).push({ type: "text", value: text });
  };

  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(src)) !== null) {
    pushText(src.slice(last, m.index));
    last = TOKEN_RE.lastIndex;

    const [, rawPath, openKind, openPath, closeKind, elseTok, escPath] = m;

    if (rawPath) {
      childrenOf(stack[stack.length - 1]).push({ type: "raw", path: rawPath });
    } else if (openKind) {
      const node = { type: openKind.slice(1), path: openPath, children: [], alt: null };
      childrenOf(stack[stack.length - 1]).push(node);
      stack.push(node);
    } else if (closeKind) {
      const expect = closeKind.slice(1);
      const top = stack[stack.length - 1];
      if (stack.length === 1 || top.type !== expect) {
        throw new Error(`microTemplate: unexpected {{/${expect}}}`);
      }
      stack.pop();
      top.inAlt = false;
    } else if (elseTok) {
      const top = stack[stack.length - 1];
      if (top.type !== "if" && top.type !== "unless") {
        throw new Error("microTemplate: {{else}} outside {{#if}}/{{#unless}}");
      }
      if (top.inAlt) throw new Error("microTemplate: duplicate {{else}}");
      top.alt = [];
      top.inAlt = true;
    } else if (escPath) {
      childrenOf(stack[stack.length - 1]).push({ type: "escaped", path: escPath });
    }
  }
  pushText(src.slice(last));

  if (stack.length !== 1) {
    throw new Error(`microTemplate: unclosed {{#${stack[stack.length - 1].type}}}`);
  }
  return root;
}

// Plain JS falsiness (so 0, "", null, undefined, NaN, false all count),
// plus empty arrays — an empty `days` list should take the {{else}} branch,
// which bare JS truthiness would get wrong.
function isFalsey(value) {
  if (Array.isArray(value)) return value.length === 0;
  return !value;
}

// Handlebars-style scope walk: try the innermost frame first, then outward.
function lookup(path, scopes) {
  if (path === "this" || path === ".") return scopes[scopes.length - 1].value;
  const parts = path.split(".");
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    const frame = scopes[i];
    if (parts[0].startsWith("@")) {
      if (frame.locals && Object.prototype.hasOwnProperty.call(frame.locals, parts[0])) {
        return frame.locals[parts[0]];
      }
      continue;
    }
    let cur = frame.value;
    let ok = cur != null && typeof cur === "object";
    for (const part of parts) {
      if (cur == null || typeof cur !== "object" || !(part in cur)) { ok = false; break; }
      cur = cur[part];
    }
    if (ok) return cur;
  }
  return undefined;
}

function renderNodes(nodes, scopes, out) {
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out.push(node.value);
        break;
      case "escaped": {
        const v = lookup(node.path, scopes);
        if (v != null && v !== false) out.push(escapeHtml(v));
        break;
      }
      case "raw": {
        const v = lookup(node.path, scopes);
        if (v != null && v !== false) out.push(String(v));
        break;
      }
      case "each": {
        const list = lookup(node.path, scopes);
        if (!Array.isArray(list)) break;
        list.forEach((item, i) => {
          scopes.push({
            value: item,
            locals: { "@index": i, "@first": i === 0, "@last": i === list.length - 1, "@number": i + 1 },
          });
          renderNodes(node.children, scopes, out);
          scopes.pop();
        });
        break;
      }
      case "if":
      case "unless": {
        const v = lookup(node.path, scopes);
        const truthy = node.type === "if" ? !isFalsey(v) : isFalsey(v);
        renderNodes(truthy ? node.children : (node.alt || []), scopes, out);
        break;
      }
      default:
        break;
    }
  }
}

/**
 * @param {string} template
 * @param {object} context
 * @returns {string}
 */
function renderTemplate(template, context) {
  const root = parse(template);
  const out = [];
  renderNodes(root.children, [{ value: context || {}, locals: {} }], out);
  return out.join("");
}

module.exports = { renderTemplate, escapeHtml, parse };
