export function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function textOrBlank(value, fallback = "") {
  return value == null ? fallback : String(value);
}

export function slugifyWebFormName(value, fallback = "web-form") {
  return (
    String(value || fallback)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || fallback
  );
}


export function buildWebFormPreviewUrl(form, origin) {
  const base = String(origin || (typeof window !== 'undefined' ? window.location.origin : 'https://crm.globusdemos.com')).replace(/\/+$/, '');
  const preview = encodeURIComponent(JSON.stringify(form || {}));
  return base + '/embed/web-form.html?preview=' + preview;
}

export function buildPublicUrl(form, origin) {
  const base = String(origin || (typeof window !== 'undefined' ? window.location.origin : 'https://crm.globusdemos.com')).replace(/\/+$/, '');
  return `${base}/embed/web-form.html?slug=${encodeURIComponent(form?.slug || '')}`;
}

export function buildWebFormEmbedCode(form, origin) {
  const base = String(origin || (typeof window !== 'undefined' ? window.location.origin : 'https://crm.globusdemos.com')).replace(/\/+$/, '');
  const slug = encodeURIComponent(form?.slug || '');
  const title = escapeHtml(form?.name || 'Web form');
  return [
    '<!-- Globussoft CRM web form -->',
    `<iframe src="${base}/embed/web-form.html?slug=${slug}" title="${title}" style="width:100%;border:0;min-height:760px;" loading="lazy"></iframe>`,
    `<p><a href="${buildPublicUrl(form, origin)}" target="_blank" rel="noopener noreferrer">Open public form</a></p>`,
  ].join('\n');
}
