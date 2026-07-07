// #447 — URL scheme allowlist before rendering into the public landing-page
// HTML. The previous implementation only HTML-escaped the URL (via
// escapeHtml on the attribute value), which prevents `"` injection but
// does NOT block dangerous schemes:
//   - <img src="javascript:alert(1)">  — modern browsers don't execute this
//     on <img>, but accepting it is still defense-in-depth wrong, and the
//     same string can flow into other sinks (a future hyperlink wrapper, an
//     email template inheriting the URL, etc.) where it WOULD execute.
//   - <a href="javascript:alert(1)">   — DOES execute in every browser. The
//     button component had this exact bug.
//   - <iframe src="javascript:...">    — rejected by most browsers but still
//     sloppy. Restrict iframe to https:/http: (videos).
//
// `safeUrl(input, kind)` returns a string suitable for embedding in the
// matching attribute. Returns the safe fallback (empty / "#" / about:blank)
// when the input fails the allowlist for that kind. Caller should
// further escapeHtml() the result before injecting into the attribute
// value (escapeHtml stays the responsibility of the renderer site so the
// helper can be tested in isolation against the scheme rules).
//
// Allowlists chosen conservatively:
//   image-src  : http:, https:, protocol-relative `//`, relative `/path`,
//                data:image/* (lets users embed inline previews if they
//                paste a base64 image; harmless because data:image/* can't
//                execute JS in modern browsers).
//   link-href  : http:, https:, mailto:, tel:, sms:, fragment `#anchor`,
//                relative paths starting with `/`, protocol-relative `//`.
//   iframe-src : http:, https:, protocol-relative `//`. NO data:.
//
// Rejected schemes (always): javascript:, vbscript:, data:text/html,
// data:application/*, file:, about:, jar:, ms-its:, mhtml:.
//
// Whitespace + URL-encoded variants: trim leading whitespace before scheme
// match (browsers do); reject if the *trimmed* value starts with a denied
// scheme (case-insensitive). The denied list is the gate; everything not
// on the allowed list also falls back, so a future protocol like
// `webcal:` requires an explicit allowlist update.
const { normalizeVideoEmbedUrl, isDirectVideoFile } = require("../lib/videoUrl");
const { getPreset: getRegistrationPreset } = require("../lib/travelRegistrationPresets");

const SAFE_FALLBACK = {
  'image-src': '',
  'link-href': '#',
  'iframe-src': 'about:blank',
};
function safeUrl(input, kind) {
  if (input == null) return SAFE_FALLBACK[kind] ?? '';
  const raw = String(input);
  // Browsers strip leading C0 whitespace AND TAB before scheme parsing —
  // mirror that so a "  javascript:..." or "\tjavascript:..." attempt is
  // caught the same way. Lowercase the prefix for a case-insensitive
  // scheme test.
  // eslint-disable-next-line no-control-regex
  const trimmed = raw.replace(/^[\s\x00-\x1f]+/, '');
  // Empty / whitespace-only input is indistinguishable from null after
  // trim — return the kind's safe fallback rather than passing through
  // an empty attribute (`<a href="">` is clickable and reloads the page).
  if (trimmed.length === 0) return SAFE_FALLBACK[kind] ?? '';
  const lower = trimmed.toLowerCase();
  // Allow same-page anchor, relative path, protocol-relative.
  if (lower.startsWith('#') || lower.startsWith('/')) return trimmed;
  // Scheme-prefixed values: walk the allowlist for the kind.
  const schemeMatch = lower.match(/^([a-z][a-z0-9+.-]*):/);
  if (!schemeMatch) {
    // No scheme + not anchor / not absolute path → treat as relative
    // ("foo.png" or "page.html" or "test"). Allow it.
    return trimmed;
  }
  const scheme = schemeMatch[1];
  if (kind === 'image-src') {
    if (scheme === 'http' || scheme === 'https') return trimmed;
    // data:image/...  but NOT data:text/html etc.
    if (scheme === 'data' && /^data:image\//i.test(trimmed)) return trimmed;
    return SAFE_FALLBACK['image-src'];
  }
  if (kind === 'link-href') {
    if (scheme === 'http' || scheme === 'https') return trimmed;
    if (scheme === 'mailto' || scheme === 'tel' || scheme === 'sms') return trimmed;
    return SAFE_FALLBACK['link-href'];
  }
  if (kind === 'iframe-src') {
    if (scheme === 'http' || scheme === 'https') return trimmed;
    return SAFE_FALLBACK['iframe-src'];
  }
  return SAFE_FALLBACK[kind] ?? '';
}

// ── Travel-block helpers ─────────────────────────────────────────
//
// All 8 travel blocks reuse the same `.trips-page .t-*` class names as the
// hardcoded Japan page (frontend/src/pages/public/TripsLanding.css). The
// shared CSS file `backend/services/landingPageRenderer.travel.css` is
// auto-injected for any page whose templateType is "travel_destination" —
// see `renderPage()` below.
//
// `tplStr(template, vars)` is a minimal {{key}} substitution helper so the
// inline countdown / scroll-target JS stays readable while keeping `slug`
// + element IDs HTML-escaped at injection time.
function tplStr(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : ""
  );
}

function travelBlockId(prefix) {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
}

// Render a "—" / null-safe pricing cell. AI never emits monetary values; if
// the operator left the value blank, the rendered cell still has visual
// weight via the dashed placeholder + "Pricing TBD" label.
function renderPricingValue(amount, currency) {
  if (amount == null || amount === "") {
    return `<div class="t-tier-amount t-tier-amount--empty" aria-label="Pricing to be configured">Pricing TBD</div>`;
  }
  const sym = escapeHtml(currency || "₹");
  return `<div class="t-tier-amount">${sym}${escapeHtml(String(amount))}</div>`;
}

function renderComponent(component, slug) {
  const { type, props = {} } = component;

  switch (type) {
    case "heading": {
      const level = props.level || "h1";
      const align = props.align || "left";
      const color = props.color || "#1a1a1a";
      return `<${level} style="color:${color};text-align:${align};margin:0 0 16px;">${escapeHtml(props.text || "")}</${level}>`;
    }

    case "text": {
      const align = props.align || "left";
      const color = props.color || "#444";
      const fontSize = props.fontSize || "16px";
      return `<p style="color:${color};text-align:${align};font-size:${fontSize};line-height:1.6;margin:0 0 16px;">${escapeHtml(props.text || "")}</p>`;
    }

    case "image": {
      const width = props.width || "100%";
      const maxWidth = props.maxWidth || "100%";
      const alt = escapeHtml(props.alt || "");
      // #447: scheme-allowlist via safeUrl before escapeHtml. Modern browsers
      // don't execute javascript: on <img> but sanitization here is
      // defense-in-depth — same string can flow into other sinks.
      return `<div style="text-align:center;margin:0 0 16px;"><img src="${escapeHtml(safeUrl(props.src, 'image-src'))}" alt="${alt}" style="width:${width};max-width:${maxWidth};height:auto;border-radius:8px;" /></div>`;
    }

    case "button": {
      const color = props.color || "#ffffff";
      const bgColor = props.bgColor || "#2563eb";
      const align = props.align || "center";
      const size = props.size || "medium";
      const padding = size === "large" ? "16px 40px" : size === "small" ? "8px 20px" : "12px 32px";
      const fontSize = size === "large" ? "18px" : size === "small" ? "13px" : "15px";
      // #447: <a href="javascript:..."> DOES execute. safeUrl strips the
      // dangerous schemes and falls back to "#" if input fails the allowlist.
      return `<div style="text-align:${align};margin:0 0 16px;"><a href="${escapeHtml(safeUrl(props.url, 'link-href'))}" style="display:inline-block;padding:${padding};background:${bgColor};color:${color};text-decoration:none;border-radius:6px;font-size:${fontSize};font-weight:600;cursor:pointer;">${escapeHtml(props.text || "Click")}</a></div>`;
    }

    case "form": {
      const fields = props.fields || [];
      const submitText = escapeHtml(props.submitText || "Submit");
      const thankYouMessage = escapeHtml(props.thankYouMessage || "Thank you for your submission!");
      const formId = "form_" + Math.random().toString(36).substr(2, 8);
      let fieldsHtml = fields
        .map((f) => {
          const req = f.required ? "required" : "";
          const inputType = f.type || "text";
          return `<div style="margin-bottom:12px;">
            <label style="display:block;margin-bottom:4px;font-weight:500;color:#333;font-size:14px;">${escapeHtml(f.label || f.name)}</label>
            <input type="${inputType}" name="${escapeHtml(f.name)}" ${req} style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:15px;box-sizing:border-box;" />
          </div>`;
        })
        .join("\n");

      // ── #451 — CAPTCHA / spam protection (Cloudflare Turnstile) ───
      // Embedded only when props.enableCaptcha === true. We use Cloudflare
      // Turnstile (free, no Google reCAPTCHA — Cloudflare already fronts
      // crm.globusdemos.com so adding it is one extra SDK call).
      // The site-key is read from props.turnstileSiteKey if provided
      // (per-form override) and falls back to the env-var default; if
      // neither is set we render the widget with a "test" site-key so
      // dev environments don't 500. The submit handler verifies the
      // token server-side.
      const enableCaptcha = !!props.enableCaptcha;
      const turnstileSiteKey =
        props.turnstileSiteKey ||
        process.env.TURNSTILE_SITE_KEY ||
        "1x00000000000000000000AA"; // Cloudflare's "always-passes" test site-key.
      const captchaScript = enableCaptcha
        ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
        : "";
      const captchaHtml = enableCaptcha
        ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(turnstileSiteKey)}" data-callback="${formId}_onTurnstile" style="margin:0 0 12px;"></div>`
        : "";

      // ── #451 — successRedirectUrl ─────────────────────────────────
      // If set, the submit-success handler redirects the visitor to this
      // URL instead of revealing the static thank-you panel. Validation:
      // accept http:// or https:// only (no javascript:, mailto:, file:,
      // etc.). Falls back to thank-you-panel mode on invalid URL or any
      // missing prop. The validation happens at render-time so a bad URL
      // never reaches the browser's location.assign.
      let successRedirectUrl = "";
      if (typeof props.successRedirectUrl === "string" && props.successRedirectUrl.length > 0) {
        try {
          const u = new URL(props.successRedirectUrl);
          if (u.protocol === "http:" || u.protocol === "https:") {
            successRedirectUrl = props.successRedirectUrl;
          }
        } catch (_e) {
          successRedirectUrl = "";
        }
      }

      // The browser-side success branch: redirect if a valid
      // successRedirectUrl is configured, otherwise reveal the
      // thank-you panel.
      const successJs = successRedirectUrl
        ? `window.location.assign(${JSON.stringify(successRedirectUrl)});`
        : `form.querySelector("button[type=submit]").style.display = "none";
            var fields = form.querySelectorAll("div > label, div > input");
            fields.forEach(function(el){ el.parentElement.style.display = "none"; });
            document.getElementById("${formId}_thanks").style.display = "block";`;

      return `${captchaScript}<form id="${formId}" style="max-width:480px;margin:0 auto 16px;padding:24px;background:#f9fafb;border-radius:10px;border:1px solid #e5e7eb;" onsubmit="return false;">
        ${fieldsHtml}
        ${captchaHtml}
        <button type="submit" style="width:100%;padding:12px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:15px;font-weight:600;cursor:pointer;">${submitText}</button>
        <div id="${formId}_thanks" style="display:none;text-align:center;padding:16px;color:#16a34a;font-weight:500;">${thankYouMessage}</div>
      </form>
      <script>
      (function(){
        var form = document.getElementById("${formId}");
        ${enableCaptcha ? `var turnstileToken = ""; window["${formId}_onTurnstile"] = function(t){ turnstileToken = t; };` : ""}
        form.addEventListener("submit", function(e){
          e.preventDefault();
          var data = {};
          var inputs = form.querySelectorAll("input");
          inputs.forEach(function(inp){ data[inp.name] = inp.value; });
          var phoneInp = form.querySelector('input[type="tel"]');
          if(phoneInp && phoneInp.value.trim()){
            var digits = phoneInp.value.replace(/\\D/g,'');
            if(digits.length < 10 || digits.length > 15){ alert('Please enter a valid phone number (10–15 digits).'); phoneInp.focus(); return; }
          }
          ${enableCaptcha ? `data.cfTurnstileToken = turnstileToken; if (!turnstileToken) { alert("Please complete the CAPTCHA challenge."); return; }` : ""}
          fetch("/p/${escapeHtml(slug)}/submit", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(data)
          }).then(function(r){ return r.json(); }).then(function(j){
            if (j && j.error) { alert(j.error); return; }
            ${successJs}
          }).catch(function(){ alert("Something went wrong. Please try again."); });
        });
      })();
      </script>`;
    }

    case "divider": {
      const color = props.color || "#e5e7eb";
      const margin = props.margin || "24px";
      return `<hr style="border:none;border-top:1px solid ${color};margin:${margin} 0;" />`;
    }

    case "spacer": {
      const height = props.height || "32px";
      return `<div style="height:${height};"></div>`;
    }

    case "video": {
      const width = props.width || "100%";
      // Normalise common URL forms (YouTube watch / Shorts / youtu.be,
      // Vimeo bare ID) to the provider's /embed path. Without this,
      // YouTube + Vimeo send X-Frame-Options: SAMEORIGIN on the non-
      // /embed paths and the iframe shows "refused to connect".
      const normalized = normalizeVideoEmbedUrl(props.url);
      // Local uploads AND remote direct video files (Pexels CDN .mp4,
      // S3-served clips, etc.) render as a native <video> control —
      // iframing a raw byte stream triggers X-Frame-Options blocking
      // because the response isn't an HTML document. safeUrl(iframe-src)
      // already accepts http(s) + relative paths so it's the right
      // allowlist for a media src too.
      if (isDirectVideoFile(normalized)) {
        return `<div style="text-align:center;margin:0 0 16px;"><video controls preload="metadata" src="${escapeHtml(safeUrl(normalized, 'iframe-src'))}" style="width:${width};max-width:100%;border-radius:8px;"></video></div>`;
      }
      // #447: iframe-src restricted to http:/https: only. data:/javascript:
      // are rejected and fall back to about:blank (renders an empty frame
      // rather than executing arbitrary HTML).
      return `<div style="text-align:center;margin:0 0 16px;"><iframe src="${escapeHtml(safeUrl(normalized, 'iframe-src'))}" style="width:${width};max-width:100%;aspect-ratio:16/9;border:none;border-radius:8px;" allowfullscreen></iframe></div>`;
    }

    case "columns": {
      const columns = props.columns || [];
      const gap = props.gap || "24px";
      const _colWidth = columns.length > 0 ? `calc(${100 / columns.length}% - ${gap})` : "100%";
      const colsHtml = columns
        .map((col) => {
          const innerHtml = (col.components || []).map((c) => renderComponent(c, slug)).join("\n");
          return `<div style="flex:1;min-width:250px;">${innerHtml}</div>`;
        })
        .join("\n");
      return `<div style="display:flex;flex-wrap:wrap;gap:${gap};margin:0 0 16px;">${colsHtml}</div>`;
    }

    // ── Travel destination blocks ────────────────────────────────────
    // Visual quality parity with the hardcoded Japan /trips page is
    // provided by the shared travel CSS file auto-injected when the
    // page's templateType === "travel_destination". These cases emit
    // semantic markup keyed on the `.t-*` class system; they do NOT
    // inline styles — every spacing / palette / typography decision
    // lives in the CSS file so designers can iterate without rebuilding
    // the renderer.

    case "destinationHero": {
      const destination = escapeHtml(props.destination || "");
      const headline = escapeHtml(props.headline || "");
      const subhead = escapeHtml(props.subhead || "");
      const posterUrl = props.posterUrl
        ? escapeHtml(safeUrl(props.posterUrl, "image-src"))
        : "";
      const ctaText = escapeHtml(props.ctaText || "Reserve Your Spot");
      const ctaScrollTarget = escapeHtml(props.ctaScrollTarget || "");
      const palette = props.palette || {};
      const bg = escapeHtml(palette.bg || "#1f1a17");
      const fg = escapeHtml(palette.fg || "#ffffff");
      const accent = escapeHtml(palette.accent || "#b8893b");
      const countdownTo = props.countdownTo || null;
      const wrapperId = travelBlockId("hero");

      const posterStyle = posterUrl
        ? `background-image:linear-gradient(rgba(0,0,0,0.45),rgba(0,0,0,0.65)),url('${posterUrl}');`
        : `background:${bg};`;

      // Countdown markup is rendered server-side with placeholder zeros;
      // the inline script ticks every 1s. If countdownTo is null we
      // simply omit the timer block entirely.
      const countdownBlock = countdownTo
        ? `<div class="t-hero-countdown" id="${wrapperId}_cd" data-target="${escapeHtml(countdownTo)}">
            <div class="t-cd-cell"><span class="t-cd-num" data-unit="d">--</span><span class="t-cd-lbl">Days</span></div>
            <div class="t-cd-cell"><span class="t-cd-num" data-unit="h">--</span><span class="t-cd-lbl">Hours</span></div>
            <div class="t-cd-cell"><span class="t-cd-num" data-unit="m">--</span><span class="t-cd-lbl">Min</span></div>
            <div class="t-cd-cell"><span class="t-cd-num" data-unit="s">--</span><span class="t-cd-lbl">Sec</span></div>
          </div>`
        : "";

      const ctaAttr = ctaScrollTarget
        ? `onclick="document.getElementById('${ctaScrollTarget}')?.scrollIntoView({behavior:'smooth'});return false;" href="#${ctaScrollTarget}"`
        : `href="#"`;

      const countdownScript = countdownTo
        ? tplStr(
            `<script>(function(){
              var root=document.getElementById('{{id}}_cd');
              if(!root)return;
              var target=new Date(root.dataset.target).getTime();
              if(isNaN(target))return;
              function pad(n){return String(n).padStart(2,'0');}
              function tick(){
                var diff=Math.max(0,target-Date.now());
                var d=Math.floor(diff/86400000);
                var h=Math.floor(diff/3600000)%24;
                var m=Math.floor(diff/60000)%60;
                var s=Math.floor(diff/1000)%60;
                var cells=root.querySelectorAll('[data-unit]');
                cells.forEach(function(c){
                  if(c.dataset.unit==='d')c.textContent=pad(d);
                  if(c.dataset.unit==='h')c.textContent=pad(h);
                  if(c.dataset.unit==='m')c.textContent=pad(m);
                  if(c.dataset.unit==='s')c.textContent=pad(s);
                });
              }
              tick();setInterval(tick,1000);
            })();</script>`,
            { id: wrapperId }
          )
        : "";

      return `<section class="t-hero" style="--t-hero-fg:${fg};--t-hero-accent:${accent};${posterStyle}">
        <div class="t-wrap t-hero-inner">
          ${destination ? `<span class="t-tag t-hero-tag">${destination}</span>` : ""}
          ${headline ? `<h1 class="t-hero-headline">${headline}</h1>` : ""}
          ${subhead ? `<p class="t-hero-subhead">${subhead}</p>` : ""}
          ${countdownBlock}
          <a class="t-cta t-hero-cta" ${ctaAttr}>${ctaText}</a>
        </div>
        ${countdownScript}
      </section>`;
    }

    case "cityCards": {
      const title = escapeHtml(props.title || "");
      const subtitle = escapeHtml(props.subtitle || "");
      const cards = Array.isArray(props.cards) ? props.cards : [];
      const cardsHtml = cards
        .map((c) => {
          const tag = escapeHtml(c.tag || "");
          const cTitle = escapeHtml(c.title || "");
          const body = escapeHtml(c.body || "");
          // PR-C: optional cultural-depth pull-quote. AI-generated content
          // can populate this to surface "what this city teaches" without
          // making the body unwieldy. Closes the CULTURAL_HIGHLIGHTS
          // parity gap from TRAVEL_LANDING_PAGE_PARITY_GAPS.md.
          const benefit = escapeHtml(c.benefit || "");
          const img = c.img ? escapeHtml(safeUrl(c.img, "image-src")) : "";
          const imgBlock = img
            ? `<div class="t-city-img" style="background-image:url('${img}')"></div>`
            : `<div class="t-city-img t-city-img--empty" aria-label="Add a city image"><span>City image</span></div>`;
          return `<article class="t-city-card">
            ${imgBlock}
            <div class="t-city-card-body">
              ${tag ? `<span class="t-tag">${tag}</span>` : ""}
              ${cTitle ? `<h3 class="t-city-title">${cTitle}</h3>` : ""}
              ${body ? `<p class="t-city-body t-muted">${body}</p>` : ""}
              ${benefit ? `<p class="t-city-benefit"><span class="t-city-benefit-label">DERIVED BENEFIT</span><em>“${benefit}”</em></p>` : ""}
            </div>
          </article>`;
        })
        .join("\n");
      return `<section class="t-section t-cities">
        <div class="t-wrap">
          ${title ? `<h2 class="t-center">${title}</h2>` : ""}
          ${subtitle ? `<p class="t-center t-muted t-section-sub">${subtitle}</p>` : ""}
          <div class="t-city-grid">${cardsHtml}</div>
        </div>
      </section>`;
    }

    case "highlightsGrid": {
      const title = escapeHtml(props.title || "");
      const subtitle = escapeHtml(props.subtitle || "");
      const items = Array.isArray(props.items) ? props.items : [];
      const cellsHtml = items
        .map((it) => {
          const icon = escapeHtml(it.icon || "◈");
          const iTitle = escapeHtml(it.title || "");
          const body = escapeHtml(it.body || "");
          return `<div class="t-highlight">
            <div class="t-highlight-icon" aria-hidden="true">${icon}</div>
            ${iTitle ? `<h4 class="t-highlight-title">${iTitle}</h4>` : ""}
            ${body ? `<p class="t-highlight-body t-muted">${body}</p>` : ""}
          </div>`;
        })
        .join("\n");
      return `<section class="t-section t-highlights">
        <div class="t-wrap">
          ${title ? `<h2 class="t-center">${title}</h2>` : ""}
          ${subtitle ? `<p class="t-center t-muted t-section-sub">${subtitle}</p>` : ""}
          <div class="t-highlight-grid">${cellsHtml}</div>
        </div>
      </section>`;
    }

    case "inclusionsGrid": {
      const title = escapeHtml(props.title || "What's Included");
      const subtitle = escapeHtml(props.subtitle || "");
      const items = Array.isArray(props.items) ? props.items : [];
      const itemsHtml = items
        .map((s) => `<li class="t-inclusion-item"><span class="t-check" aria-hidden="true">✓</span><span>${escapeHtml(String(s || ""))}</span></li>`)
        .join("\n");
      return `<section class="t-section t-inclusions">
        <div class="t-wrap t-narrow">
          ${title ? `<h2 class="t-center">${title}</h2>` : ""}
          ${subtitle ? `<p class="t-center t-muted t-section-sub">${subtitle}</p>` : ""}
          <ul class="t-inclusion-list">${itemsHtml}</ul>
        </div>
      </section>`;
    }

    case "itineraryTimeline": {
      const title = escapeHtml(props.title || "Day-by-day");
      const subtitle = escapeHtml(props.subtitle || "");
      const days = Array.isArray(props.days) ? props.days : [];
      const daysHtml = days
        .map((d) => {
          const dayNum = Number.isFinite(d.day) ? Number(d.day) : "";
          const dTitle = escapeHtml(d.title || "");
          // PR-C: optional per-day icon (single character, displayed in
          // the day marker) and secondary notes line (italic, below the
          // bullets — used for things like "Optional evening activity"
          // or "Free time at this location"). Both empty by default.
          const icon = escapeHtml(d.icon || "");
          const notes = escapeHtml(d.notes || "");
          const bullets = Array.isArray(d.bullets) ? d.bullets : [];
          const bulletsHtml = bullets
            .map((b) => `<li>${escapeHtml(String(b || ""))}</li>`)
            .join("\n");
          // Marker content: icon takes precedence if present (matches the
          // /trips cultural-highlights icon-per-day visual). Otherwise
          // shows the day number as before.
          const markerInner = icon
            ? `<span class="t-day-icon" aria-hidden="true">${icon}</span>`
            : `<span class="t-day-num">${escapeHtml(String(dayNum))}</span>`;
          return `<li class="t-day">
            <div class="t-day-marker">${markerInner}</div>
            <div class="t-day-body">
              ${dTitle ? `<h4 class="t-day-title">${dTitle}</h4>` : ""}
              ${bulletsHtml ? `<ul class="t-day-bullets">${bulletsHtml}</ul>` : ""}
              ${notes ? `<p class="t-day-notes"><em>${notes}</em></p>` : ""}
            </div>
          </li>`;
        })
        .join("\n");
      return `<section class="t-section t-itinerary">
        <div class="t-wrap">
          ${title ? `<h2 class="t-center">${title}</h2>` : ""}
          ${subtitle ? `<p class="t-center t-muted t-section-sub">${subtitle}</p>` : ""}
          <ol class="t-day-list">${daysHtml}</ol>
        </div>
      </section>`;
    }

    case "tierPricing": {
      const title = escapeHtml(props.title || "Investment");
      const subtitle = escapeHtml(props.subtitle || "");
      const currency = props.currency || "₹";
      const tiers = Array.isArray(props.tiers) ? props.tiers : [];
      const tiersHtml = tiers
        .map((t) => {
          const step = Number.isFinite(t.step) ? Number(t.step) : "";
          const label = escapeHtml(t.label || "");
          const subLabel = escapeHtml(t.subtitle || "");
          const dueDate = escapeHtml(t.dueDate || "");
          const vendor = escapeHtml(t.vendor || "");
          const tag = escapeHtml(t.tag || "");
          // PR-C: optional prominent badge (e.g. "Most Popular", "Early
          // Bird", "Recommended"). Visually distinct from `tag` —
          // sits ABOVE the tier card, ribbon-style. AI never fills this;
          // operator selects from a small allowlist in the builder.
          const badge = escapeHtml(t.badge || "");
          const tierClass = badge ? "t-tier t-tier--badged" : "t-tier";
          return `<div class="${tierClass}">
            ${badge ? `<span class="t-tier-badge">${badge}</span>` : ""}
            <div class="t-tier-step">Step ${escapeHtml(String(step))}</div>
            ${label ? `<h4 class="t-tier-label">${label}</h4>` : ""}
            ${subLabel ? `<div class="t-tier-sublabel t-muted">${subLabel}</div>` : ""}
            ${renderPricingValue(t.amount, currency)}
            ${dueDate ? `<div class="t-tier-due">Due: ${dueDate}</div>` : ""}
            ${vendor ? `<div class="t-tier-vendor">${vendor}</div>` : ""}
            ${tag ? `<span class="t-tier-tag">${tag}</span>` : ""}
          </div>`;
        })
        .join("\n");
      return `<section class="t-section t-pricing">
        <div class="t-wrap">
          ${title ? `<h2 class="t-center">${title}</h2>` : ""}
          ${subtitle ? `<p class="t-center t-muted t-section-sub">${subtitle}</p>` : ""}
          <div class="t-tier-grid">${tiersHtml}</div>
        </div>
      </section>`;
    }

    case "faqAccordion": {
      const title = escapeHtml(props.title || "Frequently Asked Questions");
      const subtitle = escapeHtml(props.subtitle || "");
      const categories = Array.isArray(props.categories) ? props.categories : [];
      const faqs = Array.isArray(props.faqs) ? props.faqs : [];
      const wrapId = travelBlockId("faq");

      const catBar = categories.length
        ? `<div class="t-faq-cats" role="tablist">${categories
            .map(
              (c) =>
                `<button type="button" class="t-faq-cat" data-cat="${escapeHtml(c.id || "all")}" role="tab">
                  <span class="t-faq-cat-icon" aria-hidden="true">${escapeHtml(c.icon || "•")}</span>
                  <span>${escapeHtml(c.label || "")}</span>
                </button>`
            )
            .join("\n")}</div>`
        : "";

      const faqsHtml = faqs
        .map((f) => {
          const cat = escapeHtml(f.cat || "");
          const q = escapeHtml(f.q || "");
          const a = escapeHtml(f.a || "");
          return `<details class="t-faq" data-cat="${cat}">
            <summary class="t-faq-q">
              <span>${q}</span>
              <span class="t-faq-icon" aria-hidden="true">+</span>
            </summary>
            <div class="t-faq-a">${a}</div>
          </details>`;
        })
        .join("\n");

      const faqScript = `<script>(function(){
        var root=document.getElementById('${wrapId}');
        if(!root)return;
        var buttons=root.querySelectorAll('.t-faq-cat');
        var items=root.querySelectorAll('.t-faq');
        var active='all';
        buttons.forEach(function(b){
          b.addEventListener('click',function(){
            active=b.dataset.cat||'all';
            buttons.forEach(function(x){x.classList.toggle('is-active',x===b);});
            items.forEach(function(it){
              var c=it.dataset.cat||'';
              it.style.display=(active==='all'||c===active)?'':'none';
            });
          });
        });
        if(buttons[0])buttons[0].classList.add('is-active');
      })();</script>`;

      return `<section class="t-section t-faqs" id="${wrapId}">
        <div class="t-wrap t-narrow">
          ${title ? `<h2 class="t-center">${title}</h2>` : ""}
          ${subtitle ? `<p class="t-center t-muted t-section-sub">${subtitle}</p>` : ""}
          ${catBar}
          <div class="t-faq-list">${faqsHtml}</div>
        </div>
        ${faqScript}
      </section>`;
    }

    case "reviewCarousel": {
      // Manual-only block. AI generator MUST emit zero of these — the
      // landing-page guardrail strips any AI-emitted review block. This
      // renderer treats whatever the operator typed as authoritative.
      const title = escapeHtml(props.title || "What People Say");
      const subtitle = escapeHtml(props.subtitle || "");
      const reviews = Array.isArray(props.reviews) ? props.reviews : [];
      const reviewsHtml = reviews
        .map((r) => {
          const initial = escapeHtml(String(r.initial || (r.name || "?").slice(0, 1)).toUpperCase());
          const name = escapeHtml(r.name || "");
          const text = escapeHtml(r.text || "");
          return `<figure class="t-review">
            <div class="t-review-avatar" aria-hidden="true">${initial}</div>
            <blockquote class="t-review-text">${text}</blockquote>
            ${name ? `<figcaption class="t-review-name">${name}</figcaption>` : ""}
          </figure>`;
        })
        .join("\n");
      return `<section class="t-section t-reviews">
        <div class="t-wrap">
          ${title ? `<h2 class="t-center">${title}</h2>` : ""}
          ${subtitle ? `<p class="t-center t-muted t-section-sub">${subtitle}</p>` : ""}
          <div class="t-review-grid">${reviewsHtml}</div>
        </div>
      </section>`;
    }

    // ── PR-C: new travel blocks ─────────────────────────────────

    case "travelVideo": {
      // Operator-added block. URL comes either from (a) a YouTube /
      // Vimeo / Wistia paste — normalised to the provider's /embed
      // path so X-Frame-Options doesn't block the render — or (b) an
      // upload via POST /api/landing-pages/upload-video, which lands
      // at /api/uploads/landing-page-videos/tenant-<id>/<file> and
      // renders as a native <video> control.
      const title = escapeHtml(props.title || "");
      const subtitle = escapeHtml(props.subtitle || "");
      const normalized = normalizeVideoEmbedUrl(props.url);
      const safeFrameUrl = normalized ? escapeHtml(safeUrl(normalized, "iframe-src")) : "";
      const aspectRatio = props.aspectRatio === "9:16" ? "9 / 16"
        : props.aspectRatio === "4:3" ? "4 / 3"
        : "16 / 9";
      let frame;
      if (!safeFrameUrl) {
        frame = `<div class="t-video-empty" aria-label="Add a YouTube, Vimeo, Wistia embed URL or upload an MP4"
             style="width:100%;aspect-ratio:${aspectRatio};border-radius:6px;">
             <span>Paste a video URL or upload an MP4</span>
           </div>`;
      } else if (isDirectVideoFile(normalized)) {
        frame = `<video controls preload="metadata" src="${safeFrameUrl}"
             style="width:100%;aspect-ratio:${aspectRatio};border-radius:6px;background:#000;"
             title="${title || 'Uploaded video'}"></video>`;
      } else {
        frame = `<iframe src="${safeFrameUrl}" allowfullscreen loading="lazy"
             style="width:100%;aspect-ratio:${aspectRatio};border:none;border-radius:6px;"
             title="${title || 'Video preview'}"></iframe>`;
      }
      return `<section class="t-section t-video-block">
        <div class="t-wrap t-narrow">
          ${title ? `<h2 class="t-center">${title}</h2>` : ""}
          ${subtitle ? `<p class="t-center t-muted t-section-sub">${subtitle}</p>` : ""}
          <div class="t-video-frame">${frame}</div>
        </div>
      </section>`;
    }

    case "safetyFeatures": {
      // Distinct from highlightsGrid — same data shape (icon/title/body
      // items) but rendered dark-on-light to mirror the /trips SAFETY
      // section. AI can populate this with generic descriptive content
      // (e.g. "Travel insurance included", "Pre-vetted accommodations")
      // — operator-specific ratios / claims stay in the operator's edit.
      const title = escapeHtml(props.title || "Engineered for Safety");
      const subtitle = escapeHtml(props.subtitle || "");
      const items = Array.isArray(props.items) ? props.items : [];
      const cellsHtml = items
        .map((it) => {
          const icon = escapeHtml(it.icon || "◈");
          const iTitle = escapeHtml(it.title || "");
          const body = escapeHtml(it.body || "");
          return `<div class="t-safety-item">
            <div class="t-safety-icon" aria-hidden="true">${icon}</div>
            ${iTitle ? `<h4 class="t-safety-title">${iTitle}</h4>` : ""}
            ${body ? `<p class="t-safety-body">${body}</p>` : ""}
          </div>`;
        })
        .join("\n");
      return `<section class="t-section t-safety">
        <div class="t-wrap">
          ${title ? `<h2 class="t-center">${title}</h2>` : ""}
          ${subtitle ? `<p class="t-center t-section-sub">${subtitle}</p>` : ""}
          <div class="t-safety-grid">${cellsHtml}</div>
        </div>
      </section>`;
    }

    case "brochureDownload": {
      // Closes the brochure-CTA gap from the parity audit. Two modes:
      //   - fileUrl set → button is a direct download link to the PDF
      //   - fileUrl null → button OPENS the optional lead-capture form;
      //     submission redirects to the file. Form fields default to
      //     name/email/phone but operator can edit.
      // AI emits this as a shell (fileUrl: null, form fields: default).
      // Operator uploads the brochure PDF via the existing
      // /api/landing-pages/upload endpoint and pastes the URL into
      // `fileUrl`.
      const title = escapeHtml(props.title || "Download the Brochure");
      const subtitle = escapeHtml(props.subtitle || "");
      const ctaText = escapeHtml(props.ctaText || "Get the Brochure");
      const fileUrl = props.fileUrl ? escapeHtml(safeUrl(props.fileUrl, "link-href")) : "";
      const blockId = travelBlockId("broch");

      // When a fileUrl is present we render a simple download button.
      // When absent, we render an inline form so visitors can request
      // the brochure (lead-capture). The form posts to the same submit
      // endpoint used by the generic form block.
      if (fileUrl) {
        return `<section class="t-section t-brochure">
          <div class="t-wrap t-narrow t-center">
            ${title ? `<h2>${title}</h2>` : ""}
            ${subtitle ? `<p class="t-muted t-section-sub">${subtitle}</p>` : ""}
            <a class="t-cta t-brochure-cta" href="${fileUrl}" target="_blank" rel="noopener" download>${ctaText}</a>
          </div>
        </section>`;
      }
      const fields = Array.isArray(props.formFields) && props.formFields.length > 0
        ? props.formFields
        : [
            { label: "Full name", name: "name", type: "text", required: true },
            { label: "Email", name: "email", type: "email", required: true },
            { label: "Phone", name: "phone", type: "tel", required: false },
          ];
      const fieldsHtml = fields
        .map((f) => {
          const req = f.required ? "required" : "";
          return `<div class="t-broch-field">
            <label>${escapeHtml(f.label || f.name)}${f.required ? ' *' : ''}</label>
            <input type="${escapeHtml(f.type || 'text')}" name="${escapeHtml(f.name)}" ${req} />
          </div>`;
        })
        .join("\n");
      return `<section class="t-section t-brochure">
        <div class="t-wrap t-narrow t-center">
          ${title ? `<h2>${title}</h2>` : ""}
          ${subtitle ? `<p class="t-muted t-section-sub">${subtitle}</p>` : ""}
          <form id="${blockId}" class="t-brochure-form" onsubmit="return false;">
            ${fieldsHtml}
            <button type="submit" class="t-cta">${ctaText}</button>
            <div id="${blockId}_thanks" class="t-brochure-thanks" style="display:none;">Thank you — check your email for the brochure.</div>
          </form>
        </div>
        <script>(function(){
          var form=document.getElementById('${blockId}');
          if(!form)return;
          form.addEventListener('submit',function(e){
            e.preventDefault();
            var data={brochureRequest:true};
            form.querySelectorAll('input').forEach(function(i){data[i.name]=i.value;});
            var brPhoneInp=form.querySelector('input[type="tel"]');
            if(brPhoneInp&&brPhoneInp.value.trim()){var d=brPhoneInp.value.replace(/\\D/g,'');if(d.length<10||d.length>15){alert('Please enter a valid phone number (10–15 digits).');brPhoneInp.focus();return;}}
            fetch('/p/${escapeHtml(slug)}/submit',{
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify(data)
            }).then(function(r){return r.json();}).then(function(){
              form.querySelectorAll('input, button').forEach(function(el){el.style.display='none';});
              document.getElementById('${blockId}_thanks').style.display='block';
            }).catch(function(){alert('Something went wrong. Please try again.');});
          });
        })();</script>
      </section>`;
    }

    case "registrationForm": {
      // Travel registration form with audience presets (TMC / RFU /
      // Travel Stall / Visa Sure / Inquiry / Custom). Field shape is
      // owned by backend/lib/travelRegistrationPresets.js; this case
      // just renders whatever `props.fields` array the operator
      // currently has — the preset only seeds defaults at insert-time
      // in the builder.
      //
      // Submission flow matches brochureDownload: posts to the same
      // /p/<slug>/submit endpoint, which honours per-form
      // leadRoutingRuleId + enableCaptcha + audience tagging.
      //
      // Phase 6 — when props.mode === "registration-draft" the inline
      // submit script wraps the form values in `fields:` (which the
      // backend's handleRegistrationDraft expects) and follows
      // response.redirect.url on success. Non-draft blocks keep the
      // original "show thank-you message" behaviour.
      const title = escapeHtml(props.title || "Register your interest");
      const subtitle = escapeHtml(props.subtitle || "");
      const submitText = escapeHtml(props.submitText || "Submit");
      const audience = escapeHtml(props.audience || "inquiry");
      const subBrand = props.subBrand ? escapeHtml(props.subBrand) : "";
      const isDraftMode = props.mode === "registration-draft";
      const blockId = travelBlockId("reg");
      const fields = Array.isArray(props.fields) && props.fields.length > 0
        ? props.fields
        : (getRegistrationPreset(props.audience) || getRegistrationPreset("inquiry")).fields;
      const fieldsHtml = fields
        .map((f) => {
          const req = f.required ? "required" : "";
          const name = escapeHtml(f.name || "");
          const label = escapeHtml(f.label || f.name || "");
          const type = escapeHtml(f.type || "text");
          return `<div class="t-reg-field">
            <label for="${blockId}_${name}">${label}${f.required ? ' *' : ''}</label>
            <input id="${blockId}_${name}" type="${type}" name="${name}" ${req} />
          </div>`;
        })
        .join("\n");
      const thanksMsg = escapeHtml(props.thankYouMessage || "Thank you — we will be in touch shortly.");
      return `<section class="t-section t-reg">
        <div class="t-wrap t-narrow">
          ${title ? `<h2 class="t-center">${title}</h2>` : ""}
          ${subtitle ? `<p class="t-center t-section-sub">${subtitle}</p>` : ""}
          <form id="${blockId}" class="t-reg-form" onsubmit="return false;" data-audience="${audience}"${subBrand ? ` data-sub-brand="${subBrand}"` : ""}${isDraftMode ? ' data-mode="registration-draft"' : ""}>
            <input type="hidden" name="audience" value="${audience}" />
            ${subBrand ? `<input type="hidden" name="subBrand" value="${subBrand}" />` : ""}
            ${fieldsHtml}
            <button type="submit" class="t-cta t-reg-submit">${submitText}</button>
            <div id="${blockId}_thanks" class="t-reg-thanks" style="display:none;">${thanksMsg}</div>
          </form>
        </div>
        <script>(function(){
          var form=document.getElementById('${blockId}');
          if(!form)return;
          var isDraft=${isDraftMode ? "true" : "false"};
          form.addEventListener('submit',function(e){
            e.preventDefault();
            var data={registrationForm:true};
            form.querySelectorAll('input').forEach(function(i){if(i.name)data[i.name]=i.value;});
            var regPhoneInp=form.querySelector('input[type="tel"]');
            if(regPhoneInp&&regPhoneInp.value.trim()){var d=regPhoneInp.value.replace(/\\D/g,'');if(d.length<10||d.length>15){alert('Please enter a valid phone number (10–15 digits).');regPhoneInp.focus();return;}}
            // Phase 6 - registration-draft mode wraps values in
            // a fields object so handleRegistrationDraft can
            // pluck student_name / parent_phone / etc. out of the
            // expected shape. Audience + subBrand stay at top level
            // so pickFormFromContent can still disambiguate the form
            // block. Lead-capture mode keeps the original flat shape.
            var body=isDraft
              ? Object.assign({},data,{fields:data,mode:'registration-draft'})
              : data;
            fetch('/p/${escapeHtml(slug)}/submit',{
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify(body)
            }).then(function(r){return r.json().then(function(j){return{status:r.status,body:j};});}).then(function(resp){
              if(resp.body && resp.body.error){alert(resp.body.error);return;}
              // Phase 6 — when the backend returns a microsite redirect
              // (registration-draft path), navigate there. The URL
              // carries only the opaque draftToken; no PII leaks via
              // query string. Fallback when no redirect → show the
              // thank-you panel.
              var redirect=resp.body && resp.body.redirect;
              if(redirect && redirect.type==='microsite' && redirect.url){
                window.location.href=redirect.url;
                return;
              }
              form.querySelectorAll('input, button').forEach(function(el){el.style.display='none';});
              var thanksEl=document.getElementById('${blockId}_thanks');
              if(thanksEl){
                if(redirect && redirect.type==='thanks' && resp.body.message){
                  thanksEl.textContent=resp.body.message;
                }
                thanksEl.style.display='block';
              }
            }).catch(function(){alert('Something went wrong. Please try again.');});
          });
        })();</script>
      </section>`;
    }

    case "contactFooter": {
      // Bottom-of-page contact strip — phone, email, optional CTA. AI
      // emits this as a shell (phone: null, email: null) because phone
      // and email are operator-specific. The structural ctaText can be
      // AI-generated; the operator types in the real phone/email/url.
      const brandName = escapeHtml(props.brandName || "");
      const phone = props.phone ? String(props.phone).trim() : "";
      const email = props.email ? String(props.email).trim() : "";
      const ctaText = escapeHtml(props.ctaText || "");
      const ctaUrl = props.ctaUrl ? escapeHtml(safeUrl(props.ctaUrl, "link-href")) : "";
      // Phone display is escaped + the tel: link uses a digits-only
      // version so a "+91 99-12345" display value still produces a
      // dial-able tel: URL.
      const phoneHref = phone ? `tel:${phone.replace(/[^\d+]/g, "")}` : "";
      return `<footer class="t-section t-contact-footer">
        <div class="t-wrap t-center">
          ${brandName ? `<div class="t-contact-brand">${brandName}</div>` : ""}
          <div class="t-contact-row">
            ${phone ? `<a class="t-contact-link" href="${escapeHtml(phoneHref)}">${escapeHtml(phone)}</a>` : `<span class="t-contact-empty">[Add phone]</span>`}
            <span class="t-contact-sep" aria-hidden="true">·</span>
            ${email ? `<a class="t-contact-link" href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>` : `<span class="t-contact-empty">[Add email]</span>`}
          </div>
          ${ctaText && ctaUrl ? `<a class="t-cta t-contact-cta" href="${ctaUrl}">${ctaText}</a>` : ""}
        </div>
      </footer>`;
    }

    default:
      return "";
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Travel CSS is loaded once at module init from a sibling file and
// inlined into every travel_destination render. The file is checked into
// the repo (see landingPageRenderer.travel.css) so visual quality is a
// source-controlled artifact, not an env-time concern.
const fs = require("fs");
const path = require("path");
let _TRAVEL_CSS_CACHE = null;
function loadTravelCss() {
  if (_TRAVEL_CSS_CACHE !== null) return _TRAVEL_CSS_CACHE;
  try {
    _TRAVEL_CSS_CACHE = fs.readFileSync(
      path.join(__dirname, "landingPageRenderer.travel.css"),
      "utf8"
    );
  } catch (_e) {
    // Fail-soft: in dev/CI where the file might be missing, ship a
    // minimal fallback that at least gives semantic structure.
    _TRAVEL_CSS_CACHE = "";
  }
  return _TRAVEL_CSS_CACHE;
}

function isTravelDestinationPage(landingPage, components) {
  if (landingPage && landingPage.templateType === "travel_destination") return true;
  // Defensive: a page may have travel blocks even without the
  // templateType marker (e.g. a generic page the user augmented). If any
  // block is a travel block, ship the CSS so it renders correctly.
  const TRAVEL_TYPES = new Set([
    "destinationHero",
    "cityCards",
    "highlightsGrid",
    "inclusionsGrid",
    "itineraryTimeline",
    "tierPricing",
    "faqAccordion",
    "reviewCarousel",
    // PR-C additions
    "travelVideo",
    "safetyFeatures",
    "brochureDownload",
    "contactFooter",
    "registrationForm",
  ]);
  return Array.isArray(components) && components.some((c) => c && TRAVEL_TYPES.has(c.type));
}

function renderPage(landingPage, options = {}) {
  // ── Phase D1 — template-driven travel microsite dispatch ──────
  //
  // If the page's templateType matches a registered template id, the
  // semantic-payload template renderer takes over. The content for
  // these pages is a JSON OBJECT (not array) keyed to template slots.
  //
  // Everything else falls through to the existing block-array path
  // below — backwards compatible with every landing page already in
  // the database.
  //
  // Late-required (cycle avoidance — the templates require this
  // module for safeUrl).
  //
  // `options.preview` — when true, the rendered HTML omits the analytics
  // tracking pixel so operator previews don't inflate `visits` counters.
  // No visual change: the pixel is a 1x1 invisible image. This is the
  // single concession to a "preview-specific" path, scoped to analytics
  // only — everything else (CSS / JS / animations / DOM) is identical
  // to production.
  const previewMode = !!options.preview;
  const templates = require("./templates");
  if (templates.isTemplatePage(landingPage)) {
    return templates.renderTemplate(landingPage, { preview: previewMode });
  }

  const {
    title = "Landing Page",
    slug = "",
    metaTitle,
    metaDescription,
    content,
    cssOverrides,
  } = landingPage;

  let components = [];
  if (content) {
    try {
      components = typeof content === "string" ? JSON.parse(content) : content;
    } catch (_e) {
      components = [];
    }
  }
  // Defensive: if content parsed to a non-array (e.g. a misconfigured
  // page whose templateType doesn't match a registered template but
  // whose content is the new object payload), coerce to empty so
  // `.map` doesn't crash. Phase D1 dispatcher above handles the
  // common case; this guard is the belt-and-braces for misconfig.
  if (!Array.isArray(components)) components = [];

  const bodyHtml = components.map((c) => renderComponent(c, slug)).join("\n");
  const pageTitle = escapeHtml(metaTitle || title);
  const pageDescription = metaDescription ? `<meta name="description" content="${escapeHtml(metaDescription)}" />` : "";
  const overrides = cssOverrides ? `<style>${cssOverrides}</style>` : "";

  const isTravel = isTravelDestinationPage(landingPage, components);
  const travelCss = isTravel ? `<style>${loadTravelCss()}</style>` : "";
  // Travel pages use the full-bleed `.trips-page` wrapper (no
  // lp-container padding) so the hero / city grids span edge-to-edge.
  const wrapperOpen = isTravel
    ? `<div class="trips-page">`
    : `<div class="lp-container">`;
  const wrapperClose = `</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${pageTitle}</title>
  ${pageDescription}
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: #1a1a1a;
      background: #ffffff;
      -webkit-font-smoothing: antialiased;
    }
    .lp-container {
      max-width: 960px;
      margin: 0 auto;
      padding: 40px 24px;
    }
    img { max-width: 100%; height: auto; }
    input:focus { outline: 2px solid #2563eb; outline-offset: -1px; }
    a:hover { opacity: 0.9; }
    @media (max-width: 640px) {
      .lp-container { padding: 24px 16px; }
      h1 { font-size: 28px !important; }
      h2 { font-size: 22px !important; }
    }
  </style>
  ${travelCss}
  ${overrides}
</head>
<body>
  ${wrapperOpen}
    ${bodyHtml}
  ${wrapperClose}
  ${previewMode ? '' : `<img src="/api/pages/${escapeHtml(slug)}/track?event=VISIT" width="1" height="1" style="position:absolute;opacity:0;" />`}
</body>
</html>`;
}

module.exports = {
  renderPage,
  safeUrl,
  renderComponent,
  isTravelDestinationPage,
  // Test-only: exposed so vitest can hot-reset the cache between tests.
  _resetTravelCssCache: () => { _TRAVEL_CSS_CACHE = null; },
};
