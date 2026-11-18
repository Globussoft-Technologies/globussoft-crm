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

function buildEmbedContainerId(form) {
  const reference = form?.id != null && String(form.id) !== '' ? form.id : form?.slug;
  const safeReference = String(reference == null ? '' : reference)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `gbs-web-form-embed-${safeReference || 'preview'}`;
}

const EMBED_TRACKING_QUERY_KEYS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_id', 'utm_term', 'utm_content',
  'gclid', 'gbraid', 'wbraid', 'fbclid', 'fbc', 'fbp', 'gad_source',
  'gad_campaignid', 'campaign_id', 'adset_id', 'ad_id', 'campaign_name',
  'adset_name', 'ad_name', 'adgroup', 'network', 'device', 'placement',
  'site_source_name', 'landing_page', 'referrer', 'hsa_acc', 'hsa_cam',
  'hsa_grp', 'hsa_ad', 'hsa_src', 'hsa_tgt', 'hsa_kw', 'hsa_mt', 'hsa_net',
  'hsa_ver',
];

function buildIframeEmbedRuntime(form, base, containerId, createContainer) {
  const reference = form?.id != null && String(form.id) !== '' ? form.id : form?.slug || '';
  const frameParams = new URLSearchParams(
    form?.id != null && String(form.id) !== '' ? { id: String(form.id) } : { slug: String(form?.slug || '') },
  );
  if (form?.scope && form.scope !== 'generic') frameParams.set('scope', form.scope);
  const config = {
    containerId,
    frameUrl: `${base}/embed/web-form.html?${frameParams.toString()}`,
    title: `${String(form?.name || 'Globus CRM').trim()} web form`,
  };
  const safeConfig = JSON.stringify(config).replace(/</g, '\\u003c');
  const shouldCreate = createContainer ? 'true' : 'false';
  return `(function(script){
if(!script||!script.parentNode)return;
var config=${safeConfig};
var keys=${JSON.stringify(EMBED_TRACKING_QUERY_KEYS)};
var taggedVisitKeys=["utm_source","utm_medium","utm_campaign","utm_id","utm_term","utm_content","gclid","gbraid","wbraid","fbclid","fbc","fbp","campaign_id","adset_id","ad_id","campaign_name","adset_name","ad_name"];
var container=null;
if(!${shouldCreate}){var previous=script.previousElementSibling;if(previous&&previous.id===config.containerId&&previous.classList.contains("gbs-web-form-embed"))container=previous;}
if(!container){container=document.createElement("div");container.className="gbs-web-form-embed";container.id=config.containerId;container.style.cssText="display:block;width:100%;";var suffix=1;while(document.getElementById(container.id)){container.id=config.containerId+"-"+suffix++;}script.parentNode.insertBefore(container,script.nextSibling);}
if(container.id===config.containerId&&document.getElementById(config.containerId)!==container){var requestedId=config.containerId,suffix=1;do{container.id=requestedId+"-"+suffix++;}while(document.getElementById(container.id)&&document.getElementById(container.id)!==container);}
if(container.dataset.gbsWebFormLoaded==="true")return;container.dataset.gbsWebFormLoaded="true";
var frame=document.createElement("iframe");frame.className="gbs-web-form-iframe";frame.title=config.title;frame.allow="geolocation *";frame.loading="lazy";frame.style.cssText="width:100%;height:620px;min-height:0;border:0;display:block;";
var frameUrl=new URL(config.frameUrl,document.baseURI);
function readCookie(name){try{var prefix=name+"=",parts=document.cookie.split(";");for(var i=0;i<parts.length;i++){var part=parts[i].trim();if(part.indexOf(prefix)===0){try{return decodeURIComponent(part.substring(prefix.length));}catch(e){return part.substring(prefix.length);}}}}catch(e){}return "";}
function writeCookie(name,value){try{document.cookie=name+"="+encodeURIComponent(String(value).slice(0,2000))+"; Max-Age=7776000; Path=/; SameSite=Lax"+(location.protocol==="https:"?"; Secure":"");}catch(e){}}
function storedAttribution(key){return readCookie("gbs_"+key)||readCookie(key)||(key==="fbc"?readCookie("_fbc"):key==="fbp"?readCookie("_fbp"):"");}
var pageQuery=new URLSearchParams(location.search);var isTaggedVisit=taggedVisitKeys.some(function(key){return pageQuery.has(key);});var attribution={};
keys.forEach(function(key){var value;if(isTaggedVisit){value=pageQuery.has(key)?(pageQuery.get(key)||""):"";writeCookie("gbs_"+key,value);}else{value=storedAttribution(key);if(value&&!readCookie("gbs_"+key))writeCookie("gbs_"+key,value);}if(value){value=String(value).slice(0,2000);attribution[key]=value;frameUrl.searchParams.set(key,value);}});
var frameOrigin=frameUrl.origin;var lastDevice="";var redirecting=false;
function device(){var width=window.innerWidth||document.documentElement.clientWidth||0;return width<=640?"mobile":width<=900?"tablet":"desktop";}
function sendDevice(){try{var next=device();if(next===lastDevice)return;lastDevice=next;frame.contentWindow.postMessage({source:"gbs-web-form-host",type:"responsive-device",device:next},frameOrigin);}catch(e){}}
function sendContext(){try{frame.contentWindow.postMessage({source:"gbs-web-form-host",type:"context",pageUrl:location.href,pageTitle:document.title,attribution:attribution},frameOrigin);sendDevice();}catch(e){}}
function safeRedirect(value){if(typeof value!=="string"||!value.trim()||value.length>2048)return "";try{var target=new URL(value.trim());if((target.protocol!=="http:"&&target.protocol!=="https:")||!target.hostname||target.username||target.password)return "";return target.href;}catch(e){return "";}}
function isFrameMessage(event){return event.source===frame.contentWindow&&event.origin===frameOrigin&&event.data&&event.data.source==="gbs-web-form";}
window.addEventListener("resize",sendDevice);
window.addEventListener("message",function(event){if(!isFrameMessage(event))return;var data=event.data;if(data.type==="ready")sendContext();if(data.type==="size"){var height=Number(data.height);if(Number.isFinite(height)&&height>0){frame.style.height=Math.ceil(height)+"px";frame.style.minHeight="0";}}if(data.type==="success-redirect"&&!redirecting){var expectedId=frameUrl.searchParams.get("id"),expectedSlug=frameUrl.searchParams.get("slug");var matches=expectedId?String(data.formId||"")===expectedId:expectedSlug?String(data.formSlug||"")===expectedSlug:false;var redirectUrl=safeRedirect(data.redirectUrl);if(matches&&redirectUrl){redirecting=true;window.location.assign(redirectUrl);}}});
frame.addEventListener("load",sendContext);container.appendChild(frame);frame.src=frameUrl.toString();
})(document.currentScript);`;
}

export function buildWebFormEmbedCode(form, origin) {
  const base = String(origin || (typeof window !== 'undefined' ? window.location.origin : 'https://crm.globusdemos.com')).replace(/\/+$/, '');
  const containerId = buildEmbedContainerId(form);
  const runtime = buildIframeEmbedRuntime(form, base, containerId, false);
  return [
    '<!-- Globussoft CRM web form -->',
    `<div class="gbs-web-form-embed" id="${containerId}" style="display:block;width:100%;"></div>`,
    `<script>${runtime}</script>`,
    `<p><a href="${buildPublicUrl(form, origin).replace(/&/g, '&amp;')}" target="_blank" rel="noopener noreferrer">Open public form</a></p>`,
  ].join('\n');
}

export function buildWebFormScriptEmbedCode(form, origin) {
  if (form?.scope && form.scope !== 'generic') return '';
  const base = String(origin || (typeof window !== 'undefined' ? window.location.origin : 'https://crm.globusdemos.com')).replace(/\/+$/, '');
  const containerId = buildEmbedContainerId(form);
  const runtime = buildIframeEmbedRuntime(form, base, containerId, true);
  return `<script>${runtime}</script>`;
}
