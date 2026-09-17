const ALLOWED_TAGS = new Set([
  'A', 'B', 'BLOCKQUOTE', 'BR', 'DEL', 'DIV', 'EM', 'FONT', 'I', 'IMG',
  'LI', 'OL', 'P', 'S', 'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP', 'U', 'UL',
]);
const DROP_CONTENT_TAGS = new Set(['IFRAME', 'OBJECT', 'SCRIPT', 'STYLE', 'TEMPLATE']);
const ALLOWED_STYLE_PROPERTIES = new Set(['font-style', 'font-weight', 'text-align', 'text-decoration']);
const FORMATTING_TAG_PATTERN = /<\/?(?:a|b|blockquote|br|del|div|em|font|i|img|li|ol|p|s|span|strike|strong|sub|sup|u|ul)(?:\s[^>]*)?>/i;
const ESCAPED_FORMATTING_TAG_PATTERN = /&lt;\/?(?:a|b|blockquote|br|del|div|em|font|i|img|li|ol|p|s|span|strike|strong|sub|sup|u|ul)(?:\s[^>]*)?&gt;/i;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function plainTextHtml(value) {
  return escapeHtml(value).replace(/\r\n?|\n/g, '<br>');
}

function safeUrl(value, { allowMailto = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw, window.location.origin);
    const allowed = ['http:', 'https:'];
    if (allowMailto) allowed.push('mailto:');
    if (!allowed.includes(parsed.protocol)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function safeStyle(value) {
  const declarations = [];
  for (const declaration of String(value || '').split(';')) {
    const separator = declaration.indexOf(':');
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const styleValue = declaration.slice(separator + 1).trim().toLowerCase();
    if (!ALLOWED_STYLE_PROPERTIES.has(property)) continue;
    const allowedValue = property === 'text-align'
      ? ['left', 'center', 'right', 'justify'].includes(styleValue)
      : property === 'font-weight'
        ? ['normal', 'bold', '400', '500', '600', '700'].includes(styleValue)
        : property === 'font-style'
          ? ['normal', 'italic'].includes(styleValue)
          : ['none', 'underline', 'line-through'].includes(styleValue);
    if (allowedValue) declarations.push(`${property}: ${styleValue}`);
  }
  return declarations.join('; ');
}

function copySafeNodes(source, target) {
  for (const node of Array.from(source.childNodes || [])) {
    if (node.nodeType === Node.TEXT_NODE) {
      target.appendChild(document.createTextNode(node.nodeValue || ''));
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = node.tagName.toUpperCase();
    if (DROP_CONTENT_TAGS.has(tag)) continue;
    if (!ALLOWED_TAGS.has(tag)) {
      copySafeNodes(node, target);
      continue;
    }

    const element = document.createElement(tag.toLowerCase());
    if (tag === 'A') {
      const href = safeUrl(node.getAttribute('href'), { allowMailto: true });
      if (href) element.setAttribute('href', href);
      const title = node.getAttribute('title');
      if (title) element.setAttribute('title', title);
      if (node.getAttribute('target') === '_blank') {
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noopener noreferrer');
      }
    } else if (tag === 'IMG') {
      const src = safeUrl(node.getAttribute('src'));
      if (!src) continue;
      element.setAttribute('src', src);
      const alt = node.getAttribute('alt');
      if (alt) element.setAttribute('alt', alt);
    } else if (tag === 'FONT') {
      const size = node.getAttribute('size');
      if (/^[1-7]$/.test(size || '')) element.setAttribute('size', size);
    }
    const style = safeStyle(node.getAttribute('style'));
    if (style) element.setAttribute('style', style);
    copySafeNodes(node, element);
    target.appendChild(element);
  }
}

export function sanitizeRichTextHtml(value) {
  const input = String(value ?? '');
  if (!input) return '';
  if (typeof DOMParser === 'undefined' || typeof document === 'undefined') return plainTextHtml(input);

  let html = input;
  if (ESCAPED_FORMATTING_TAG_PATTERN.test(input)) {
    const decoded = new DOMParser().parseFromString(input, 'text/html').body.textContent || '';
    if (FORMATTING_TAG_PATTERN.test(decoded)) html = decoded;
  }
  if (!FORMATTING_TAG_PATTERN.test(html)) return plainTextHtml(html);

  const parsed = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const source = parsed.body.firstElementChild;
  const output = document.createElement('div');
  if (source) copySafeNodes(source, output);
  return output.innerHTML;
}

export function isRichTextMarkup(value) {
  const input = String(value ?? '');
  return FORMATTING_TAG_PATTERN.test(input) || ESCAPED_FORMATTING_TAG_PATTERN.test(input);
}

export function richTextToPlainText(value) {
  const input = String(value ?? '');
  if (!input) return '';
  if (typeof DOMParser === 'undefined') return input;
  const decoded = ESCAPED_FORMATTING_TAG_PATTERN.test(input)
    ? (new DOMParser().parseFromString(input, 'text/html').body.textContent || '')
    : input;
  const parsed = new DOMParser().parseFromString(decoded, 'text/html');
  return (parsed.body.textContent || decoded).replace(/\u00a0/g, ' ');
}

function visibleTextWithBreaks(node) {
  let text = '';
  for (const child of Array.from(node.childNodes || [])) {
    if (child.nodeType === Node.TEXT_NODE) {
      text += child.nodeValue || '';
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      text += child.tagName.toUpperCase() === 'BR' ? '\n' : visibleTextWithBreaks(child);
    }
  }
  return text;
}

function removeFollowingContent(node, root) {
  let current = node;
  while (current && current !== root) {
    let sibling = current.nextSibling;
    while (sibling) {
      const next = sibling.nextSibling;
      sibling.remove();
      sibling = next;
    }
    current = current.parentNode;
  }
}

export function truncateRichTextHtml(value, maxWords = 50) {
  const html = sanitizeRichTextHtml(value);
  const limit = Math.max(0, Number(maxWords) || 0);
  if (!html) return { html: '', wordCount: 0, truncated: false };
  if (typeof document === 'undefined') {
    const words = String(value ?? '').trim().split(/\s+/).filter(Boolean);
    return { html, wordCount: words.length, truncated: words.length > limit };
  }

  const source = document.createElement('div');
  source.innerHTML = html;
  const wordCount = visibleTextWithBreaks(source).trim().split(/\s+/).filter(Boolean).length;
  if (wordCount <= limit) return { html, wordCount, truncated: false };

  const walker = document.createTreeWalker(source, 4);
  const textNodes = [];
  let node = walker.nextNode();
  while (node) {
    textNodes.push(node);
    node = walker.nextNode();
  }

  let remaining = limit;
  for (const textNode of textNodes) {
    const text = textNode.nodeValue || '';
    const matches = [...text.matchAll(/\S+/g)];
    if (matches.length <= remaining) {
      remaining -= matches.length;
      continue;
    }
    if (remaining === 0) {
      textNode.nodeValue = '…';
    } else {
      const lastWord = matches[remaining - 1];
      textNode.nodeValue = `${text.slice(0, lastWord.index + lastWord[0].length)}…`;
    }
    removeFollowingContent(textNode, source);
    break;
  }
  return { html: source.innerHTML, wordCount, truncated: true };
}

export function RichText({ value, as: Element = 'div', className, style }) {
  return <Element className={className} style={style} dangerouslySetInnerHTML={{ __html: sanitizeRichTextHtml(value) }} />;
}
