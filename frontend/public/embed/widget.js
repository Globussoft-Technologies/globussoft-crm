/*!
 * Globussoft CRM — drop-in lead capture widget
 *
 * Usage (in the website's HTML):
 *   <div data-gbs-form
 *        data-key="glbs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
 *        data-slug="enhanced-wellness"
 *        data-title="Get a free hair-loss consultation"
 *        data-color="#7c3aed"></div>
 *   <script async src="https://crm.globusdemos.com/embed/widget.js"></script>
 *
 * Either `data-key` (writes to /api/v1/external/leads using a partner API key)
 * or `data-slug` (writes to public booking endpoint) is required.
 *
 * The script auto-discovers all elements with the `data-gbs-form` attribute
 * and renders an iframe pointing at /embed/lead-form.html, passing the
 * config via URL params. The iframe auto-resizes to fit its content via
 * postMessage.
 */
(function () {
  if (window.__gbsFormLoaded) return;
  window.__gbsFormLoaded = true;

  // Resolve our own base URL from the script src
  var thisScript = document.currentScript || (function () {
    var ss = document.getElementsByTagName('script');
    for (var i = ss.length - 1; i >= 0; i--) if ((ss[i].src || '').indexOf('embed/widget.js') !== -1) return ss[i];
    return null;
  })();
  var apiBase = (function () {
    if (!thisScript) return 'https://crm.globusdemos.com';
    try { var u = new URL(thisScript.src); return u.origin; } catch (e) { return 'https://crm.globusdemos.com'; }
  })();

  function mountOne(target) {
    if (!target || target.__gbsMounted) return;
    target.__gbsMounted = true;

    var key = target.getAttribute('data-key') || '';
    var slug = target.getAttribute('data-slug') || '';
    var title = target.getAttribute('data-title') || '';
    var subtitle = target.getAttribute('data-subtitle') || '';
    var color = target.getAttribute('data-color') || '';
    var services = target.getAttribute('data-services') || '';
    var height = parseInt(target.getAttribute('data-height') || '0', 10);

    var qs = new URLSearchParams();
    if (key) qs.set('key', key);
    if (slug) qs.set('slug', slug);
    if (title) qs.set('title', title);
    if (subtitle) qs.set('sub', subtitle);
    if (color) qs.set('color', color);
    if (services) qs.set('services', services);
    qs.set('api', apiBase);

    var iframe = document.createElement('iframe');
    iframe.src = apiBase + '/embed/lead-form.html?' + qs.toString();
    iframe.style.cssText = 'width:100%;border:0;display:block;background:transparent;min-height:' + (height || 480) + 'px;';
    iframe.setAttribute('title', 'Globussoft lead capture');
    iframe.setAttribute('loading', 'lazy');

    target.innerHTML = '';
    target.appendChild(iframe);

    // Auto-resize iframe based on postMessage from the form page
    window.addEventListener('message', function (e) {
      if (!e.data || e.data.source !== 'gbs-form' || e.data.type !== 'size') return;
      if (e.source !== iframe.contentWindow) return;
      var h = parseInt(e.data.height, 10);
      if (h > 0) iframe.style.minHeight = (h + 8) + 'px';
    });
  }

  function mountAll() {
    var nodes = document.querySelectorAll('[data-gbs-form]');
    for (var i = 0; i < nodes.length; i++) mountOne(nodes[i]);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll);
  else mountAll();

  // Watch for late-mounted elements (SPAs)
  if (typeof MutationObserver !== 'undefined') {
    var mo = new MutationObserver(mountAll);
    mo.observe(document.body, { childList: true, subtree: true });
  }
})();
