/* Globussoft CRM - Embeddable Live Chat Widget
 * Drop into any website:
 *   <script src="https://crm.globusdemos.com/crm-livechat.js" data-tenant="1"></script>
 * Renders a floating chat bubble. Visitors fill in name/email on first
 * use, then send messages to assigned agents in the CRM. Uses HTTP
 * polling (3s) for inbound messages — no extra deps required.
 */
(function () {
  'use strict';

  // ── Resolve script tag + API base ─────────────────────────────────
  var scriptEl = (function () {
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      var src = scripts[i].src || '';
      if (src.indexOf('crm-livechat.js') !== -1) return scripts[i];
    }
    return null;
  })();

  var TENANT_ID = (scriptEl && scriptEl.getAttribute('data-tenant')) || '1';
  var API_BASE = (window.CRM_LIVECHAT_API_BASE) ||
    (scriptEl ? new URL(scriptEl.src, window.location.href).origin : window.location.origin);

  // ── Persistent visitor identity ──────────────────────────────────
  function getVisitorId() {
    var id = localStorage.getItem('crm_livechat_visitor_id');
    if (!id) {
      id = 'v_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('crm_livechat_visitor_id', id);
    }
    return id;
  }
  function getStoredProfile() {
    try { return JSON.parse(localStorage.getItem('crm_livechat_profile') || 'null'); }
    catch (e) { return null; }
  }
  function setStoredProfile(p) {
    localStorage.setItem('crm_livechat_profile', JSON.stringify(p));
  }
  function getActiveSession() {
    try { return JSON.parse(localStorage.getItem('crm_livechat_session') || 'null'); }
    catch (e) { return null; }
  }
  function setActiveSession(s) {
    if (s) localStorage.setItem('crm_livechat_session', JSON.stringify(s));
    else localStorage.removeItem('crm_livechat_session');
  }

  // ── State ────────────────────────────────────────────────────────
  var state = {
    open: false,
    sessionId: null,
    profile: getStoredProfile(),
    messages: [],
    lastMessageId: 0,
    closed: false,
    poller: null,
  };

  var existing = getActiveSession();
  if (existing && existing.sessionId) state.sessionId = existing.sessionId;

  // ── Styles (injected once) ───────────────────────────────────────
  var STYLE = '\
.crmlc-bubble{position:fixed;bottom:20px;right:20px;width:60px;height:60px;border-radius:50%;\
background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;box-shadow:0 8px 24px rgba(37,99,235,.4);\
display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2147483646;\
border:none;transition:transform .2s;}\
.crmlc-bubble:hover{transform:scale(1.08);}\
.crmlc-bubble svg{width:28px;height:28px;}\
.crmlc-window{position:fixed;bottom:90px;right:20px;width:340px;height:500px;\
background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.18);z-index:2147483647;\
display:flex;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}\
.crmlc-header{background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;padding:14px 16px;\
display:flex;justify-content:space-between;align-items:center;}\
.crmlc-header-title{font-weight:600;font-size:15px;}\
.crmlc-header-sub{font-size:11px;opacity:.85;margin-top:2px;}\
.crmlc-close{background:transparent;border:none;color:#fff;cursor:pointer;font-size:20px;line-height:1;padding:0 4px;}\
.crmlc-body{flex:1;display:flex;flex-direction:column;background:#f9fafb;overflow:hidden;}\
.crmlc-messages{flex:1;overflow-y:auto;padding:12px;}\
.crmlc-msg{display:flex;margin-bottom:8px;}\
.crmlc-msg-bubble{max-width:78%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.4;word-break:break-word;}\
.crmlc-msg.visitor{justify-content:flex-end;}\
.crmlc-msg.visitor .crmlc-msg-bubble{background:#3b82f6;color:#fff;border-bottom-right-radius:2px;}\
.crmlc-msg.agent .crmlc-msg-bubble{background:#e5e7eb;color:#111827;border-bottom-left-radius:2px;}\
.crmlc-msg.system{justify-content:center;font-size:11px;color:#9ca3af;margin:6px 0;}\
.crmlc-msg-time{font-size:10px;opacity:.7;margin-top:2px;}\
.crmlc-form{padding:16px;display:flex;flex-direction:column;gap:10px;background:#fff;}\
.crmlc-form h4{margin:0 0 4px;color:#111827;font-size:15px;}\
.crmlc-form p{margin:0 0 8px;color:#6b7280;font-size:12px;}\
.crmlc-input{padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;outline:none;width:100%;box-sizing:border-box;}\
.crmlc-input:focus{border-color:#3b82f6;}\
.crmlc-btn{background:#3b82f6;color:#fff;border:none;padding:10px 14px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;}\
.crmlc-btn:hover{background:#2563eb;}\
.crmlc-btn:disabled{opacity:.5;cursor:not-allowed;}\
.crmlc-composer{display:flex;gap:6px;padding:10px;border-top:1px solid #e5e7eb;background:#fff;}\
.crmlc-composer input{flex:1;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;outline:none;}\
.crmlc-composer button{background:#3b82f6;color:#fff;border:none;padding:0 14px;border-radius:6px;cursor:pointer;font-size:13px;}\
.crmlc-rating{padding:14px;background:#fef3c7;text-align:center;border-top:1px solid #fde68a;}\
.crmlc-stars{display:flex;justify-content:center;gap:6px;margin:8px 0;}\
.crmlc-star{font-size:24px;cursor:pointer;color:#d1d5db;}\
.crmlc-star.filled{color:#f59e0b;}\
@media (max-width:480px){\
  .crmlc-window{width:calc(100vw - 20px);right:10px;left:10px;height:70vh;bottom:80px;}\
  .crmlc-bubble{bottom:15px;right:15px;}\
}';

  function injectStyles() {
    if (document.getElementById('crmlc-styles')) return;
    var s = document.createElement('style');
    s.id = 'crmlc-styles';
    s.appendChild(document.createTextNode(STYLE));
    document.head.appendChild(s);
  }

  // ── DOM helpers ──────────────────────────────────────────────────
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === 'class') e.className = attrs[k];
        else if (k === 'html') e.innerHTML = attrs[k];
        else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), attrs[k]);
        else e.setAttribute(k, attrs[k]);
      }
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null) return;
        e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return e;
  }

  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ── API calls ────────────────────────────────────────────────────
  function api(path, options) {
    options = options || {};
    options.headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    return fetch(API_BASE + '/api/live-chat/visitor' + path, options).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function startSession(name, email) {
    return api('/start', {
      method: 'POST',
      body: JSON.stringify({
        tenantId: TENANT_ID,
        visitorId: getVisitorId(),
        visitorName: name,
        visitorEmail: email,
      }),
    }).then(function (data) {
      state.sessionId = data.sessionId;
      setActiveSession({ sessionId: data.sessionId, started: Date.now() });
      return data;
    });
  }

  function sendMessage(body) {
    if (!state.sessionId) return Promise.reject(new Error('no session'));
    return api('/' + state.sessionId + '/message', {
      method: 'POST',
      body: JSON.stringify({ body: body }),
    });
  }

  function fetchMessages() {
    if (!state.sessionId) return Promise.resolve();
    return api('/' + state.sessionId + '/messages', { method: 'GET' }).then(function (data) {
      var msgs = data.messages || [];
      // Detect new messages
      var maxId = state.lastMessageId;
      msgs.forEach(function (m) { if (m.id > maxId) maxId = m.id; });
      if (msgs.length !== state.messages.length || maxId !== state.lastMessageId) {
        state.messages = msgs;
        state.lastMessageId = maxId;
        renderMessages();
      }
      // Detect closed by agent
      if (data.session && data.session.status === 'CLOSED' && !state.closed) {
        state.closed = true;
        renderRating();
      }
    }).catch(function (err) { console.warn('[crm-livechat] poll failed', err); });
  }

  function rateSession(rating) {
    if (!state.sessionId) return Promise.resolve();
    return api('/' + state.sessionId + '/rate', {
      method: 'POST',
      body: JSON.stringify({ rating: rating }),
    });
  }

  // ── Polling ──────────────────────────────────────────────────────
  function startPolling() {
    if (state.poller) return;
    fetchMessages();
    state.poller = setInterval(fetchMessages, 3000);
  }
  function stopPolling() {
    if (state.poller) { clearInterval(state.poller); state.poller = null; }
  }

  // ── Rendering ────────────────────────────────────────────────────
  var bubbleEl, windowEl, messagesContainer, composerEl, ratingEl, formEl;

  function renderBubble() {
    bubbleEl = el('button', {
      class: 'crmlc-bubble',
      'aria-label': 'Open chat',
      onclick: toggleWindow,
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>',
    });
    document.body.appendChild(bubbleEl);
  }

  function renderWindow() {
    if (windowEl) return;
    windowEl = el('div', { class: 'crmlc-window' }, [
      el('div', { class: 'crmlc-header' }, [
        el('div', null, [
          el('div', { class: 'crmlc-header-title' }, 'Chat with us'),
          el('div', { class: 'crmlc-header-sub' }, 'We typically reply within minutes'),
        ]),
        el('button', { class: 'crmlc-close', 'aria-label': 'Close', onclick: toggleWindow }, '\u00D7'),
      ]),
      el('div', { class: 'crmlc-body', id: 'crmlc-body' }),
    ]);
    document.body.appendChild(windowEl);
    renderBody();
  }

  function renderBody() {
    var body = windowEl.querySelector('.crmlc-body');
    body.innerHTML = '';

    // No session yet → name/email form
    if (!state.sessionId) {
      formEl = el('form', {
        class: 'crmlc-form',
        onsubmit: function (e) {
          e.preventDefault();
          var name = formEl.querySelector('input[name=name]').value.trim();
          var email = formEl.querySelector('input[name=email]').value.trim();
          if (!name) return;
          var btn = formEl.querySelector('button');
          btn.disabled = true;
          btn.textContent = 'Connecting...';
          startSession(name, email).then(function () {
            setStoredProfile({ name: name, email: email });
            state.profile = { name: name, email: email };
            renderBody();
            startPolling();
          }).catch(function (err) {
            btn.disabled = false;
            btn.textContent = 'Start chat';
            alert('Failed to start chat. Please try again.');
            console.error(err);
          });
        },
      }, [
        el('h4', null, 'Hi there! \uD83D\uDC4B'),
        el('p', null, 'Tell us a bit about yourself so we can help.'),
        el('input', { class: 'crmlc-input', name: 'name', placeholder: 'Your name', required: 'true', value: (state.profile && state.profile.name) || '' }),
        el('input', { class: 'crmlc-input', name: 'email', type: 'email', placeholder: 'Email (optional)', value: (state.profile && state.profile.email) || '' }),
        el('button', { class: 'crmlc-btn', type: 'submit' }, 'Start chat'),
      ]);
      body.appendChild(formEl);
      return;
    }

    // Active session → message thread + composer
    messagesContainer = el('div', { class: 'crmlc-messages', id: 'crmlc-messages' });
    body.appendChild(messagesContainer);

    if (state.closed) {
      renderRating();
    } else {
      composerEl = el('form', {
        class: 'crmlc-composer',
        onsubmit: function (e) {
          e.preventDefault();
          var input = composerEl.querySelector('input');
          var text = input.value.trim();
          if (!text) return;
          input.value = '';
          // Optimistic append
          state.messages.push({
            id: 'tmp_' + Date.now(),
            sender: 'visitor',
            body: text,
            createdAt: new Date().toISOString(),
          });
          renderMessages();
          sendMessage(text).then(fetchMessages).catch(function (err) {
            console.error('[crm-livechat] send failed', err);
          });
        },
      }, [
        el('input', { type: 'text', placeholder: 'Type a message...', autocomplete: 'off' }),
        el('button', { type: 'submit' }, 'Send'),
      ]);
      body.appendChild(composerEl);
    }

    renderMessages();
  }

  function renderMessages() {
    if (!messagesContainer) return;
    messagesContainer.innerHTML = '';
    state.messages.forEach(function (m) {
      if (m.sender === 'system') {
        messagesContainer.appendChild(el('div', { class: 'crmlc-msg system' }, m.body));
        return;
      }
      var cls = 'crmlc-msg ' + (m.sender === 'visitor' ? 'visitor' : 'agent');
      messagesContainer.appendChild(
        el('div', { class: cls }, [
          el('div', { class: 'crmlc-msg-bubble' }, [
            el('div', null, m.body),
            el('div', { class: 'crmlc-msg-time' }, fmtTime(m.createdAt)),
          ]),
        ])
      );
    });
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function renderRating() {
    var body = windowEl && windowEl.querySelector('.crmlc-body');
    if (!body) return;
    if (composerEl && composerEl.parentNode) composerEl.parentNode.removeChild(composerEl);
    if (ratingEl && ratingEl.parentNode) ratingEl.parentNode.removeChild(ratingEl);

    var selected = 0;
    var stars = [1, 2, 3, 4, 5].map(function (n) {
      return el('span', {
        class: 'crmlc-star',
        'data-n': n,
        onclick: function () {
          selected = n;
          stars.forEach(function (s, i) {
            s.className = 'crmlc-star' + (i < n ? ' filled' : '');
          });
        },
      }, '\u2605');
    });

    ratingEl = el('div', { class: 'crmlc-rating' }, [
      el('div', null, 'Chat closed. How was your experience?'),
      (function () {
        var row = el('div', { class: 'crmlc-stars' });
        stars.forEach(function (s) { row.appendChild(s); });
        return row;
      })(),
      el('button', {
        class: 'crmlc-btn',
        onclick: function () {
          if (!selected) { setActiveSession(null); resetWidget(); return; }
          rateSession(selected).then(function () {
            setActiveSession(null);
            resetWidget();
          }).catch(function () {
            setActiveSession(null);
            resetWidget();
          });
        },
      }, 'Submit'),
    ]);
    body.appendChild(ratingEl);
  }

  function resetWidget() {
    state.sessionId = null;
    state.messages = [];
    state.lastMessageId = 0;
    state.closed = false;
    stopPolling();
    if (windowEl && windowEl.parentNode) {
      windowEl.parentNode.removeChild(windowEl);
      windowEl = null;
    }
    state.open = false;
  }

  function toggleWindow() {
    state.open = !state.open;
    if (state.open) {
      renderWindow();
      if (state.sessionId) startPolling();
    } else {
      stopPolling();
      if (windowEl && windowEl.parentNode) {
        windowEl.parentNode.removeChild(windowEl);
        windowEl = null;
      }
    }
  }

  // ── Bootstrap ────────────────────────────────────────────────────
  function init() {
    injectStyles();
    renderBubble();
    // If a session was active in localStorage, silently begin polling so
    // the badge can show new agent messages later (kept lightweight).
    if (state.sessionId) {
      fetchMessages().then(function () {
        if (state.closed) {
          // Stale closed session — clear it so the visitor starts fresh.
          setActiveSession(null);
          state.sessionId = null;
          state.messages = [];
          state.closed = false;
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
