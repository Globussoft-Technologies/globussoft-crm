import { SEARCH_HIGHLIGHT_MARK_STYLE } from '../ui/SearchHighlight';

export const GLOBAL_SEARCH_HIGHLIGHT_SCOPE_ATTR = 'data-search-highlight-scope';
export const GLOBAL_SEARCH_HIGHLIGHT_SCOPE_VALUE = 'global-search';
export const GLOBAL_SEARCH_HIGHLIGHT_MARK_ATTR = 'data-global-search-highlight';

const GLOBAL_SEARCH_SKIP_SELECTOR = [
  'mark',
  'input',
  'textarea',
  'select',
  'option',
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'math',
  '[data-search-highlight-ignore]',
].join(', ');

function getOwnerDocument(root) {
  if (root?.ownerDocument) return root.ownerDocument;
  if (typeof document !== 'undefined') return document;
  return null;
}

function normalizeQuery(query) {
  return String(query ?? '').trim();
}

function createHighlightMark(ownerDocument, text) {
  const mark = ownerDocument.createElement('mark');
  mark.setAttribute(GLOBAL_SEARCH_HIGHLIGHT_MARK_ATTR, 'true');
  Object.assign(mark.style, SEARCH_HIGHLIGHT_MARK_STYLE);
  mark.textContent = text;
  return mark;
}

export function clearGlobalSearchHighlights(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  const ownerDocument = getOwnerDocument(root);
  if (!ownerDocument) return 0;

  const marks = Array.from(
    root.querySelectorAll(`mark[${GLOBAL_SEARCH_HIGHLIGHT_MARK_ATTR}="true"]`),
  );

  marks.forEach((mark) => {
    const textNode = ownerDocument.createTextNode(mark.textContent || '');
    mark.replaceWith(textNode);
  });

  return marks.length;
}

function highlightTextNode(textNode, needle, ownerDocument) {
  const text = textNode.nodeValue || '';
  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let index = lowerText.indexOf(lowerNeedle);

  if (index === -1) return 0;

  const fragment = ownerDocument.createDocumentFragment();
  let cursor = 0;
  let matches = 0;

  while (index !== -1) {
    if (index > cursor) {
      fragment.appendChild(ownerDocument.createTextNode(text.slice(cursor, index)));
    }

    fragment.appendChild(
      createHighlightMark(ownerDocument, text.slice(index, index + needle.length)),
    );
    matches += 1;
    cursor = index + needle.length;
    index = lowerText.indexOf(lowerNeedle, cursor);
  }

  if (cursor < text.length) {
    fragment.appendChild(ownerDocument.createTextNode(text.slice(cursor)));
  }

  const parent = textNode.parentNode;
  if (parent) parent.replaceChild(fragment, textNode);
  return matches;
}

export function highlightGlobalSearchRoot(root, query) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  const ownerDocument = getOwnerDocument(root);
  if (!ownerDocument) return 0;

  const needle = normalizeQuery(query);
  clearGlobalSearchHighlights(root);

  if (needle.length < 2) return 0;

  const NodeFilterApi = ownerDocument.defaultView?.NodeFilter;
  const SHOW_TEXT = NodeFilterApi?.SHOW_TEXT ?? 4;
  const FILTER_ACCEPT = NodeFilterApi?.FILTER_ACCEPT ?? 1;
  const FILTER_REJECT = NodeFilterApi?.FILTER_REJECT ?? 2;

  const walker = ownerDocument.createTreeWalker(root, SHOW_TEXT, {
    acceptNode(node) {
      if (!node?.parentElement) return FILTER_REJECT;
      if (node.parentElement.closest(GLOBAL_SEARCH_SKIP_SELECTOR)) {
        return FILTER_REJECT;
      }
      const text = node.nodeValue || '';
      if (!text.trim()) return FILTER_REJECT;
      if (!text.toLowerCase().includes(needle.toLowerCase())) return FILTER_REJECT;
      return FILTER_ACCEPT;
    },
  });

  const textNodes = [];
  let current = walker.nextNode();
  while (current) {
    textNodes.push(current);
    current = walker.nextNode();
  }

  let matches = 0;
  textNodes.forEach((node) => {
    matches += highlightTextNode(node, needle, ownerDocument);
  });

  return matches;
}

export function getGlobalSearchHighlightRoots(
  rootDocument = typeof document !== 'undefined' ? document : null,
) {
  if (!rootDocument || typeof rootDocument.querySelectorAll !== 'function') return [];
  return Array.from(
    rootDocument.querySelectorAll(
      `[${GLOBAL_SEARCH_HIGHLIGHT_SCOPE_ATTR}="${GLOBAL_SEARCH_HIGHLIGHT_SCOPE_VALUE}"]`,
    ),
  );
}

export function clearGlobalSearchHighlightRoots(
  rootDocument = typeof document !== 'undefined' ? document : null,
) {
  const roots = getGlobalSearchHighlightRoots(rootDocument);
  let total = 0;
  roots.forEach((root) => {
    total += clearGlobalSearchHighlights(root);
  });
  return total;
}

export function highlightGlobalSearchRoots(
  rootDocument = typeof document !== 'undefined' ? document : null,
  query,
) {
  const roots = getGlobalSearchHighlightRoots(rootDocument);
  let total = 0;
  roots.forEach((root) => {
    total += highlightGlobalSearchRoot(root, query);
  });
  return total;
}
