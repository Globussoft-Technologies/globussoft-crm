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
  return base + '/embed/web-form.html#preview=' + preview;
}

export function buildPublicUrl(form, origin) {
  const base = String(origin || (typeof window !== 'undefined' ? window.location.origin : 'https://crm.globusdemos.com')).replace(/\/+$/, '');
  // Prefer the stable numeric id so renames never break shared links.
  // Older slug-based links keep working via the backend's slug fallback.
  const scope = form?.scope && form.scope !== 'generic' ? `&scope=${encodeURIComponent(form.scope)}` : '';
  if (form?.id != null && String(form.id) !== '') return `${base}/embed/web-form.html?id=${encodeURIComponent(form.id)}${scope}`;
  return `${base}/embed/web-form.html?slug=${encodeURIComponent(form?.slug || '')}${scope}`;
}

export function buildWebFormEmbedCode(form, origin) {
  const base = String(origin || (typeof window !== 'undefined' ? window.location.origin : 'https://crm.globusdemos.com')).replace(/\/+$/, '');
  const scope = form?.scope && form.scope !== 'generic' ? `&scope=${encodeURIComponent(form.scope)}` : '';
  const query = `${form?.id != null && String(form.id) !== '' ? `id=${encodeURIComponent(form.id)}` : `slug=${encodeURIComponent(form?.slug || '')}`}${scope}`;
  const title = escapeHtml(form?.name || 'Web form');
  return [
    '<!-- Globussoft CRM web form -->',
    `<iframe src="${base}/embed/web-form.html?${query}" title="${title}" style="width:100%;border:0;min-height:760px;" loading="lazy"></iframe>`,
    `<p><a href="${buildPublicUrl(form, origin)}" target="_blank" rel="noopener noreferrer">Open public form</a></p>`,
  ].join('\n');
}
