/* Globussoft CRM - Embeddable Visitor Push Script
 * Drop into any website:
 *   <script src="https://crm.globusdemos.com/crm-push.js"></script>
 * Adds a small "Get notifications" floating button that subscribes the
 * visitor to web push and posts the subscription to the CRM backend
 * (no auth required; tracked as a visitor subscription).
 */
(function () {
  'use strict';

  // Resolve API base. Defaults to the origin that served this script.
  // Site owners can override by setting window.CRM_PUSH_API_BASE before load.
  var API_BASE = (typeof window !== 'undefined' && window.CRM_PUSH_API_BASE)
    ? window.CRM_PUSH_API_BASE
    : (function () {
        try {
          var scripts = document.getElementsByTagName('script');
          for (var i = scripts.length - 1; i >= 0; i--) {
            var src = scripts[i].src || '';
            if (src.indexOf('crm-push.js') !== -1) {
              return new URL(src).origin;
            }
          }
        } catch (e) {}
        return window.location.origin;
      })();

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; i++) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  function isSupported() {
    return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
  }

  function log() {
    try { console.log.apply(console, ['[crm-push]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  function warn() {
    try { console.warn.apply(console, ['[crm-push]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  async function subscribeVisitor() {
    if (!isSupported()) {
      warn('Web push not supported in this browser');
      return false;
    }

    try {
      // Register SW (served from same origin as this script).
      // Falls back to /sw.js relative to current page if cross-origin SW not allowed.
      var swUrl = API_BASE + '/sw.js';
      var registration;
      try {
        registration = await navigator.serviceWorker.register(swUrl);
      } catch (e) {
        // Cross-origin SW registration fails; try same-origin /sw.js if hosted there
        registration = await navigator.serviceWorker.register('/sw.js');
      }
      await navigator.serviceWorker.ready;

      var permission = Notification.permission;
      if (permission === 'default') {
        permission = await Notification.requestPermission();
      }
      if (permission !== 'granted') {
        warn('Permission not granted:', permission);
        return false;
      }

      var vapidRes = await fetch(API_BASE + '/api/push/vapid-key');
      if (!vapidRes.ok) {
        warn('Failed to fetch VAPID key');
        return false;
      }
      var vapidJson = await vapidRes.json();
      if (!vapidJson.publicKey) {
        warn('Missing VAPID public key in response');
        return false;
      }

      var subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidJson.publicKey),
        });
      }

      var sub = subscription.toJSON();
      var body = {
        endpoint: sub.endpoint,
        p256dh: sub.keys && sub.keys.p256dh,
        auth: sub.keys && sub.keys.auth,
        url: window.location.href,
        userAgent: navigator.userAgent,
      };

      var postRes = await fetch(API_BASE + '/api/push/subscribe/visitor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!postRes.ok) {
        warn('Server rejected subscription:', postRes.status);
        return false;
      }

      log('Visitor subscribed for push notifications');
      try { localStorage.setItem('crm_push_subscribed', '1'); } catch (e) {}
      return true;
    } catch (err) {
      warn('subscribeVisitor error:', err);
      return false;
    }
  }

  function injectStyles() {
    if (document.getElementById('crm-push-styles')) return;
    var style = document.createElement('style');
    style.id = 'crm-push-styles';
    style.textContent =
      '#crm-push-btn{position:fixed;bottom:20px;right:20px;z-index:2147483646;' +
      'padding:10px 16px;border:none;border-radius:999px;cursor:pointer;' +
      'background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;' +
      'font:600 14px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
      'box-shadow:0 6px 20px rgba(99,102,241,.4);display:flex;align-items:center;gap:8px;' +
      'transition:transform .15s ease,box-shadow .15s ease;}' +
      '#crm-push-btn:hover{transform:translateY(-1px);box-shadow:0 8px 24px rgba(99,102,241,.5);}' +
      '#crm-push-btn[disabled]{opacity:.7;cursor:default;}' +
      '#crm-push-btn svg{width:16px;height:16px;}';
    document.head.appendChild(style);
  }

  function shouldShowButton() {
    if (!isSupported()) return false;
    if (Notification.permission === 'denied') return false;
    try {
      if (localStorage.getItem('crm_push_subscribed') === '1' &&
          Notification.permission === 'granted') {
        return false;
      }
    } catch (e) {}
    return true;
  }

  function injectButton() {
    if (document.getElementById('crm-push-btn')) return;
    if (!shouldShowButton()) return;
    injectStyles();

    var btn = document.createElement('button');
    btn.id = 'crm-push-btn';
    btn.type = 'button';
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
      '<path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm6-6V11a6 6 0 1 0-12 0v5l-2 2v1h16v-1l-2-2Z"/>' +
      '</svg><span>Get notifications</span>';
    btn.addEventListener('click', async function () {
      btn.disabled = true;
      btn.querySelector('span').textContent = 'Subscribing...';
      var ok = await subscribeVisitor();
      if (ok) {
        btn.querySelector('span').textContent = 'Subscribed';
        setTimeout(function () { btn.remove(); }, 1500);
      } else {
        btn.querySelector('span').textContent = 'Get notifications';
        btn.disabled = false;
      }
    });
    document.body.appendChild(btn);
  }

  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectButton);
    } else {
      injectButton();
    }
  }

  // Public API
  window.CRMPush = {
    subscribe: subscribeVisitor,
    isSupported: isSupported,
    apiBase: API_BASE,
  };

  init();
})();
