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

const EMBED_ATTRIBUTION_QUERY_KEYS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'gbraid', 'wbraid', 'fbclid', 'fbc', 'fbp', 'gad_source',
  'gad_campaignid', 'adgroup', 'network', 'device', 'placement', 'hsa_acc',
  'hsa_cam', 'hsa_grp', 'hsa_ad', 'hsa_src', 'hsa_tgt', 'hsa_kw', 'hsa_mt',
  'hsa_net', 'hsa_ver',
];

function buildEmbedHostRuntime(enableAttribution, frameExpression = 'document.currentScript.previousElementSibling') {
  if (!enableAttribution) {
    return `(function(frame){if(!frame)return;var lastDevice="";function device(){var width=window.innerWidth||document.documentElement.clientWidth||0;return width<=640?"mobile":width<=900?"tablet":"desktop";}function sendDevice(){try{var next=device();if(next===lastDevice)return;lastDevice=next;frame.contentWindow.postMessage({source:"gbs-web-form-host",type:"responsive-device",device:next},"*");}catch(e){}}function send(){try{frame.contentWindow.postMessage({source:"gbs-web-form-host",type:"context",pageUrl:location.href,pageTitle:document.title},"*");}catch(e){}sendDevice();}window.addEventListener("resize",sendDevice);window.addEventListener("message",function(event){if(event.source!==frame.contentWindow||!event.data||event.data.source!=="gbs-web-form")return;if(event.data.type==="ready")send();if(event.data.type==="size"){var height=Number(event.data.height);if(Number.isFinite(height)&&height>0){frame.style.height=Math.ceil(height)+"px";frame.style.minHeight="0";}}});frame.addEventListener("load",send);})(${frameExpression});`;
  }
  const keys = JSON.stringify(EMBED_ATTRIBUTION_QUERY_KEYS);
  return `(function(frame){if(!frame)return;var keys=${keys},maxAge=7776000,lastDevice="";function readCookie(name){try{var prefix=name+"=",parts=document.cookie.split(";");for(var i=0;i<parts.length;i++){var part=parts[i].trim();if(part.indexOf(prefix)===0){try{return decodeURIComponent(part.substring(prefix.length));}catch(e){return part.substring(prefix.length);}}}}catch(e){}return "";}function remember(name,value){if(!value)return readCookie(name);var saved=readCookie(name);if(saved)return saved;try{document.cookie=name+"="+encodeURIComponent(String(value).slice(0,2000))+"; Max-Age="+maxAge+"; Path=/; SameSite=Lax"+(location.protocol==="https:"?"; Secure":"");}catch(e){}return value;}function attribution(){var values={},query;try{query=new URLSearchParams(location.search);}catch(e){query=null;}for(var i=0;i<keys.length;i++){var key=keys[i],value=query?query.get(key):"";value=remember("gbs_"+key,value||"");if(value)values[key]=value;}return values;}var savedAttribution=attribution();function device(){var width=window.innerWidth||document.documentElement.clientWidth||0;return width<=640?"mobile":width<=900?"tablet":"desktop";}function sendDevice(){try{var next=device();if(next===lastDevice)return;lastDevice=next;frame.contentWindow.postMessage({source:"gbs-web-form-host",type:"responsive-device",device:next},"*");}catch(e){}}function send(){try{frame.contentWindow.postMessage({source:"gbs-web-form-host",type:"context",pageUrl:location.href,pageTitle:document.title,attribution:savedAttribution},"*");}catch(e){}sendDevice();}window.addEventListener("resize",sendDevice);window.addEventListener("message",function(event){if(event.source!==frame.contentWindow||!event.data||event.data.source!=="gbs-web-form")return;if(event.data.type==="ready")send();if(event.data.type==="size"){var height=Number(event.data.height);if(Number.isFinite(height)&&height>0){frame.style.height=Math.ceil(height)+"px";frame.style.minHeight="0";}}});frame.addEventListener("load",send);})(${frameExpression});`;
}

function buildEmbedHostScript(enableAttribution) {
  return `<script>${buildEmbedHostRuntime(enableAttribution)}</script>`;
}

export function buildWebFormEmbedCode(form, origin) {
  const base = String(origin || (typeof window !== 'undefined' ? window.location.origin : 'https://crm.globusdemos.com')).replace(/\/+$/, '');
  const scope = form?.scope && form.scope !== 'generic' ? `&scope=${encodeURIComponent(form.scope)}` : '';
  const query = `${form?.id != null && String(form.id) !== '' ? `id=${encodeURIComponent(form.id)}` : `slug=${encodeURIComponent(form?.slug || '')}`}${scope}`;
  const title = escapeHtml(form?.name || 'Web form');
  return [
    '<!-- Globussoft CRM web form -->',
    `<iframe src="${base}/embed/web-form.html?${query}" title="${title}" allow="geolocation *" style="width:100%;height:auto;border:0;display:block;" loading="lazy"></iframe>`,
    buildEmbedHostScript(!form?.scope || form.scope === 'generic'),
    `<p><a href="${buildPublicUrl(form, origin)}" target="_blank" rel="noopener noreferrer">Open public form</a></p>`,
  ].join('\n');
}

export function buildWebFormScriptEmbedCode(form, origin) {
  if (form?.scope && form.scope !== 'generic') return '';
  const src = buildPublicUrl(form, origin);
  const safeJson = (value) => JSON.stringify(String(value)).replace(/</g, '\\u003c');
  const trackingKeys = JSON.stringify(EMBED_ATTRIBUTION_QUERY_KEYS);
  // Put the captured attribution on the iframe URL as a transport fallback.
  // This makes script-only embeds work even when a browser/proxy delays or
  // drops the cross-window postMessage handshake. The form iframe then reads
  // the same values from its own URL and includes them in the submit payload.
  const forwardAttribution = `var trackingKeys=${trackingKeys};try{var frameUrl=new URL(frame.src,document.baseURI),pageQuery=new URLSearchParams(window.location.search);function readTrackingCookie(name){try{var prefix=name+"=",parts=document.cookie.split(";");for(var i=0;i<parts.length;i++){var part=parts[i].trim();if(part.indexOf(prefix)===0){try{return decodeURIComponent(part.substring(prefix.length));}catch(e){return part.substring(prefix.length);}}}}catch(e){}return "";}trackingKeys.forEach(function(key){var value=pageQuery.get(key)||readTrackingCookie("gbs_"+key);if(value)frameUrl.searchParams.set(key,String(value).slice(0,2000));});frame.src=frameUrl.toString();}catch(e){}`;
  return `<script>(function(script){if(!script||!script.parentNode)return;var frame=document.createElement("iframe");frame.src=${safeJson(src)};frame.title=${safeJson(form?.name || 'Web form')};frame.allow="geolocation *";frame.loading="lazy";frame.style.cssText="width:100%;height:auto;border:0;display:block;";${forwardAttribution}script.parentNode.insertBefore(frame,script.nextSibling);${buildEmbedHostRuntime(true, 'frame')}})(document.currentScript);</script>`;
}
