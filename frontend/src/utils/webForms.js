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


export function buildWebFormPreviewUrl(form, origin, options = {}) {
  const base = String(origin || (typeof window !== 'undefined' ? window.location.origin : 'https://crm.globusdemos.com')).replace(/\/+$/, '');
  const preview = encodeURIComponent(JSON.stringify(form || {}));
  const query = new URLSearchParams({ previewVersion: String(Date.now()) });
  if (options.previewDevice) query.set('device', String(options.previewDevice));
  if (form?.scope && form.scope !== 'generic') query.set('scope', String(form.scope));
  return base + '/embed/web-form.html?' + query.toString() + '#preview=' + preview;
}

export function getWebFormPreviewViewportWidth(device) {
  if (device === 'mobile') return '440px';
  if (device === 'tablet') return '768px';
  return '100%';
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
    `<iframe src="${base}/embed/web-form.html?${query}" title="${title}" allow="geolocation *" style="width:100%;height:auto;border:0;display:block;" loading="lazy"></iframe>`,
    '<script>(function(frame){if(!frame)return;var lastDevice="";function device(){var width=window.innerWidth||document.documentElement.clientWidth||0;return width<=640?"mobile":width<=900?"tablet":"desktop";}function sendDevice(){try{var next=device();if(next===lastDevice)return;lastDevice=next;frame.contentWindow.postMessage({source:"gbs-web-form-host",type:"responsive-device",device:next},"*");}catch(e){}}function send(){try{frame.contentWindow.postMessage({source:"gbs-web-form-host",type:"context",pageUrl:location.href,pageTitle:document.title},"*");}catch(e){}sendDevice();}window.addEventListener("resize",sendDevice);window.addEventListener("message",function(event){if(event.source!==frame.contentWindow||!event.data||event.data.source!=="gbs-web-form")return;if(event.data.type==="ready")send();if(event.data.type==="size"){var height=Number(event.data.height);if(Number.isFinite(height)&&height>0){frame.style.height=Math.ceil(height)+"px";frame.style.minHeight="0";}}});frame.addEventListener("load",send);})(document.currentScript.previousElementSibling);</script>',
    `<p><a href="${buildPublicUrl(form, origin)}" target="_blank" rel="noopener noreferrer">Open public form</a></p>`,
  ].join('\n');
}
