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

export function hasDuplicateWebFormName(forms, name, excludeId = null) {
  const normalizedName = String(name == null ? "" : name).trim().toLowerCase();
  if (!normalizedName) return false;

  return (Array.isArray(forms) ? forms : []).some((form) => (
    String(form?.id) !== String(excludeId) &&
    String(form?.name == null ? "" : form.name).trim().toLowerCase() === normalizedName
  ));
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
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_id', 'utm_term', 'utm_content',
  'gclid', 'gbraid', 'wbraid', 'fbclid', 'fbc', 'fbp', 'gad_source',
  'gad_campaignid', 'campaign_id', 'adset_id', 'ad_id', 'campaign_name',
  'adset_name', 'ad_name', 'adgroup', 'network', 'device', 'placement',
  'site_source_name', 'landing_page', 'referrer', 'hsa_acc',
  'hsa_cam', 'hsa_grp', 'hsa_ad', 'hsa_src', 'hsa_tgt', 'hsa_kw', 'hsa_mt',
  'hsa_net', 'hsa_ver',
];

export const GENERIC_TRACKING_COOKIE_KEYS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_id', 'utm_term', 'utm_content',
  'gclid', 'gbraid', 'wbraid', 'fbclid', 'fbc', 'fbp', 'campaign_id',
  'adset_id', 'ad_id', 'campaign_name', 'adset_name', 'ad_name', 'placement',
  'site_source_name', 'landing_page', 'referrer',
];

const GENERIC_TAGGED_VISIT_KEYS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_id', 'utm_term', 'utm_content',
  'gclid', 'gbraid', 'wbraid', 'fbclid', 'fbc', 'fbp',
  'campaign_id', 'adset_id', 'ad_id', 'campaign_name', 'adset_name', 'ad_name',
]);

export function normalizeTrackingCookieDomain(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';

  let hostname = raw;
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    hostname = parsed.hostname;
  } catch {
    return '';
  }

  hostname = hostname.toLowerCase().replace(/\.$/, '');
  if (
    !hostname ||
    hostname === 'localhost' ||
    /^[\d.]+$/.test(hostname) ||
    hostname.length > 253 ||
    hostname.split('.').some((label) => !label || label.length > 63 || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label))
  ) return '';
  return hostname;
}

/**
 * Return a self-contained snippet customers can paste into their website.
 * It keeps a tagged campaign for 90 days, replacing the complete saved
 * campaign whenever a new tagged visit arrives. The `gbs_` prefix avoids
 * overwriting a website's own analytics cookies.
 */
export function buildGenericTrackingCookieSetupCode(cookieDomain = '') {
  const keys = JSON.stringify(GENERIC_TRACKING_COOKIE_KEYS);
  const taggedVisitKeys = JSON.stringify([...GENERIC_TAGGED_VISIT_KEYS]);
  const normalizedDomain = normalizeTrackingCookieDomain(cookieDomain);
  const domainAttribute = normalizedDomain ? `; Domain=${normalizedDomain}` : '';
  return `<script>
(function saveGlobussoftTrackingCookies() {
  var keys = ${keys};
  var taggedVisitKeys = ${taggedVisitKeys};
  var maxAge = 90 * 24 * 60 * 60;
  var params = new URLSearchParams(window.location.search);
  var isTaggedVisit = taggedVisitKeys.some(function (key) { return params.has(key); });
  if (!isTaggedVisit) return;
  keys.forEach(function (key) {
    var value = params.has(key) ? (params.get(key) || "") : "";
    document.cookie = "gbs_" + key + "=" + encodeURIComponent(value.slice(0, 2000))
      + "; Max-Age=" + maxAge + "; Path=/; SameSite=Lax${domainAttribute}"
      + (window.location.protocol === "https:" ? "; Secure" : "");
  });
})();
</script>`;
}

function buildEmbedHostRuntime(enableAttribution, frameExpression = 'document.currentScript.previousElementSibling', cookieDomain = '') {
  if (!enableAttribution) {
    return `(function(frame){if(!frame)return;var lastDevice="";function device(){var width=window.innerWidth||document.documentElement.clientWidth||0;return width<=640?"mobile":width<=900?"tablet":"desktop";}function sendDevice(){try{var next=device();if(next===lastDevice)return;lastDevice=next;frame.contentWindow.postMessage({source:"gbs-web-form-host",type:"responsive-device",device:next},"*");}catch(e){}}function send(){try{frame.contentWindow.postMessage({source:"gbs-web-form-host",type:"context",pageUrl:location.href,pageTitle:document.title},"*");}catch(e){}sendDevice();}window.addEventListener("resize",sendDevice);window.addEventListener("message",function(event){if(event.source!==frame.contentWindow||!event.data||event.data.source!=="gbs-web-form")return;if(event.data.type==="ready")send();if(event.data.type==="size"){var height=Number(event.data.height);if(Number.isFinite(height)&&height>0){frame.style.height=Math.ceil(height)+"px";frame.style.minHeight="0";}}});frame.addEventListener("load",send);})(${frameExpression});`;
  }
  const keys = JSON.stringify(EMBED_ATTRIBUTION_QUERY_KEYS);
  const domainAttribute = normalizeTrackingCookieDomain(cookieDomain) ? `; Domain=${normalizeTrackingCookieDomain(cookieDomain)}` : '';
  return `(function(frame){if(!frame)return;var keys=${keys},taggedVisitKeys=["utm_source","utm_medium","utm_campaign","utm_id","utm_term","utm_content","gclid","gbraid","wbraid","fbclid","fbc","fbp","campaign_id","adset_id","ad_id","campaign_name","adset_name","ad_name"],maxAge=7776000,lastDevice="";function readCookie(name){try{var prefix=name+"=",parts=document.cookie.split(";");for(var i=0;i<parts.length;i++){var part=parts[i].trim();if(part.indexOf(prefix)===0){try{return decodeURIComponent(part.substring(prefix.length));}catch(e){return part.substring(prefix.length);}}}}catch(e){}return "";}function storedAttribution(key){return readCookie("gbs_"+key)||readCookie(key)||(key==="fbc"?readCookie("_fbc"):key==="fbp"?readCookie("_fbp"):"");}function writeCookie(name,value){try{document.cookie=name+"="+encodeURIComponent(String(value).slice(0,2000))+"; Max-Age="+maxAge+"; Path=/; SameSite=Lax${domainAttribute}"+(location.protocol==="https:"?"; Secure":"");}catch(e){}}function attribution(){var values={},query;try{query=new URLSearchParams(location.search);}catch(e){query=null;}var isTaggedVisit=query&&taggedVisitKeys.some(function(key){return query.has(key);});for(var i=0;i<keys.length;i++){var key=keys[i],value;if(isTaggedVisit){value=query.has(key)?(query.get(key)||""):"";writeCookie("gbs_"+key,value);}else{value=storedAttribution(key);if(value&&!readCookie("gbs_"+key))writeCookie("gbs_"+key,value);}if(value)values[key]=value;}return values;}var savedAttribution=attribution();function device(){var width=window.innerWidth||document.documentElement.clientWidth||0;return width<=640?"mobile":width<=900?"tablet":"desktop";}function sendDevice(){try{var next=device();if(next===lastDevice)return;lastDevice=next;frame.contentWindow.postMessage({source:"gbs-web-form-host",type:"responsive-device",device:next},"*");}catch(e){}}function send(){try{frame.contentWindow.postMessage({source:"gbs-web-form-host",type:"context",pageUrl:location.href,pageTitle:document.title,attribution:savedAttribution},"*");}catch(e){}sendDevice();}window.addEventListener("resize",sendDevice);window.addEventListener("message",function(event){if(event.source!==frame.contentWindow||!event.data||event.data.source!=="gbs-web-form")return;if(event.data.type==="ready")send();if(event.data.type==="size"){var height=Number(event.data.height);if(Number.isFinite(height)&&height>0){frame.style.height=Math.ceil(height)+"px";frame.style.minHeight="0";}}});frame.addEventListener("load",send);})(${frameExpression});`;
}

function buildEmbedHostScript(enableAttribution, cookieDomain = '') {
  return `<script>${buildEmbedHostRuntime(enableAttribution, 'document.currentScript.previousElementSibling', cookieDomain)}</script>`;
}

export function buildWebFormEmbedCode(form, origin) {
  const base = String(origin || (typeof window !== 'undefined' ? window.location.origin : 'https://crm.globusdemos.com')).replace(/\/+$/, '');
  const scope = form?.scope && form.scope !== 'generic' ? `&scope=${encodeURIComponent(form.scope)}` : '';
  const query = `${form?.id != null && String(form.id) !== '' ? `id=${encodeURIComponent(form.id)}` : `slug=${encodeURIComponent(form?.slug || '')}`}${scope}`;
  const title = escapeHtml(form?.name || 'Web form');
  return [
    '<!-- Globussoft CRM web form -->',
    `<iframe src="${base}/embed/web-form.html?${query}" title="${title}" allow="geolocation *" style="width:100%;height:auto;border:0;display:block;" loading="lazy"></iframe>`,
    buildEmbedHostScript(!form?.scope || form.scope === 'generic', form?.settings?.trackingCookieDomain),
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
  const forwardAttribution = `var trackingKeys=${trackingKeys};try{var frameUrl=new URL(frame.src,document.baseURI),pageQuery=new URLSearchParams(window.location.search);function readTrackingCookie(name){try{var prefix=name+"=",parts=document.cookie.split(";");for(var i=0;i<parts.length;i++){var part=parts[i].trim();if(part.indexOf(prefix)===0){try{return decodeURIComponent(part.substring(prefix.length));}catch(e){return part.substring(prefix.length);}}}}catch(e){}return "";}function storedTrackingCookie(key){return readTrackingCookie("gbs_"+key)||readTrackingCookie(key)||(key==="fbc"?readTrackingCookie("_fbc"):key==="fbp"?readTrackingCookie("_fbp"):"");}trackingKeys.forEach(function(key){var value=storedTrackingCookie(key)||pageQuery.get(key);if(value)frameUrl.searchParams.set(key,String(value).slice(0,2000));});frame.src=frameUrl.toString();}catch(e){}`;
  return `<script>(function(script){if(!script||!script.parentNode)return;var frame=document.createElement("iframe");frame.src=${safeJson(src)};frame.title=${safeJson(form?.name || 'Web form')};frame.allow="geolocation *";frame.loading="lazy";frame.style.cssText="width:100%;height:auto;border:0;display:block;";${forwardAttribution}script.parentNode.insertBefore(frame,script.nextSibling);${buildEmbedHostRuntime(true, 'frame', form?.settings?.trackingCookieDomain)}})(document.currentScript);</script>`;
}
