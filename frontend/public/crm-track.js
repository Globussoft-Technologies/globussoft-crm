/* Globussoft CRM - Embeddable Visitor Tracking Script
 * Drop into any website:
 *   <script src="https://crm.globusdemos.com/crm-track.js" data-tenant="1"></script>
 *
 * Tracks page views per session and supports identifying visitors by email
 * via window.crmTrack.identify('user@example.com').
 */
(function () {
  'use strict';

  // Locate this script tag and resolve API base + tenantId
  function findSelf() {
    try {
      var scripts = document.getElementsByTagName('script');
      for (var i = scripts.length - 1; i >= 0; i--) {
        var s = scripts[i];
        var src = s.src || '';
        if (src.indexOf('crm-track.js') !== -1) return s;
      }
    } catch (e) {}
    return null;
  }

  var selfScript = findSelf();
  var API_BASE = (function () {
    if (typeof window !== 'undefined' && window.CRM_TRACK_API_BASE) return window.CRM_TRACK_API_BASE;
    if (selfScript && selfScript.src) {
      try { return new URL(selfScript.src).origin; } catch (e) {}
    }
    return window.location.origin;
  })();

  var TENANT_ID = (function () {
    if (selfScript && selfScript.getAttribute('data-tenant')) {
      var n = parseInt(selfScript.getAttribute('data-tenant'), 10);
      if (!isNaN(n) && n > 0) return n;
    }
    if (typeof window !== 'undefined' && window.CRM_TRACK_TENANT_ID) return window.CRM_TRACK_TENANT_ID;
    return 1;
  })();

  var STORAGE_KEY = 'crm_visitor_sid';

  function log() {
    try { console.log.apply(console, ['[crm-track]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  function genSessionId() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (e) {}
    // Fallback: timestamp + random
    return 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
  }

  function getSessionId() {
    try {
      var existing = localStorage.getItem(STORAGE_KEY);
      if (existing) return existing;
      var sid = genSessionId();
      localStorage.setItem(STORAGE_KEY, sid);
      return sid;
    } catch (e) {
      // localStorage blocked — fall back to in-memory id (will be ephemeral)
      if (!window.__crmTrackEphemeralSid) window.__crmTrackEphemeralSid = genSessionId();
      return window.__crmTrackEphemeralSid;
    }
  }

  function postJSON(path, body) {
    try {
      return fetch(API_BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
        credentials: 'omit',
      }).then(function (r) { return r.ok ? r.json().catch(function () { return {}; }) : null; })
        .catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function trackPageView() {
    var body = {
      sessionId: getSessionId(),
      tenantId: TENANT_ID,
      url: window.location.href,
      userAgent: navigator.userAgent,
    };
    return postJSON('/api/web-visitors/track', body);
  }

  function identify(email) {
    if (!email) return Promise.resolve(null);
    var body = {
      sessionId: getSessionId(),
      tenantId: TENANT_ID,
      email: String(email).trim().toLowerCase(),
    };
    return postJSON('/api/web-visitors/identify', body);
  }

  // Hook history.pushState / replaceState for SPA navigation
  function hookHistory() {
    try {
      var origPush = history.pushState;
      var origReplace = history.replaceState;
      history.pushState = function () {
        var ret = origPush.apply(this, arguments);
        try { trackPageView(); } catch (e) {}
        return ret;
      };
      history.replaceState = function () {
        var ret = origReplace.apply(this, arguments);
        try { trackPageView(); } catch (e) {}
        return ret;
      };
      window.addEventListener('popstate', function () {
        try { trackPageView(); } catch (e) {}
      });
    } catch (e) {}
  }

  function init() {
    hookHistory();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', trackPageView);
    } else {
      trackPageView();
    }
  }

  // Public API
  window.crmTrack = {
    identify: identify,
    track: trackPageView,
    sessionId: getSessionId,
    apiBase: API_BASE,
    tenantId: TENANT_ID,
  };

  init();
  log('Tracking initialized', { tenant: TENANT_ID, sid: getSessionId() });
})();
