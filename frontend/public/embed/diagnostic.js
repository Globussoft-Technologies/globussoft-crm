(function () {
  var script = document.currentScript;
  if (!script) return;
  var tenant = script.getAttribute('data-tenant') || '';
  var subBrand = script.getAttribute('data-sub-brand') || '';
  var config = script.getAttribute('data-config') || '';
  var selector = script.getAttribute('data-container') || '';
  var target = selector ? document.querySelector(selector) : script.parentElement;
  if (!target || !tenant || !subBrand) return;
  var base = new URL(script.src, window.location.href).origin;
  var iframe = document.createElement('iframe');
  iframe.src = base + '/embed/diagnostic.html?tenant=' + encodeURIComponent(tenant) + '&subBrand=' + encodeURIComponent(subBrand) + (config ? '&config=' + config : '');
  iframe.title = 'Travel diagnostic';
  iframe.loading = 'lazy';
  iframe.style.cssText = 'width:100%;min-height:720px;border:0;display:block;';
  target.replaceChildren(iframe);
  window.addEventListener('message', function (event) {
    if (event.source !== iframe.contentWindow || !event.data || event.data.source !== 'gbs-diagnostic-embed') return;
    if (event.data.type === 'size' && Number.isFinite(Number(event.data.height))) iframe.style.height = Math.max(240, Number(event.data.height)) + 'px';
    if (event.data.type === 'scroll_to_loading') {
      var position = Math.max(0, Math.min(1, Number(event.data.position) || 0.5));
      var iframeTop = iframe.getBoundingClientRect().top + window.scrollY;
      var targetY = iframeTop + (iframe.offsetHeight * position) - (window.innerHeight / 2);
      window.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
    }
    if (event.data.type === 'diagnostic_completed') {
      window.dispatchEvent(new CustomEvent('diagnostic_completed', { detail: { diagnosticId: event.data.diagnosticId || null } }));
    }
  });
})();
