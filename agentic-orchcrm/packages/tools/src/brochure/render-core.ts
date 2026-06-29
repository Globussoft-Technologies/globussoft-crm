/**
 * Brochure render engine — content + template → a complete, print-ready HTML
 * document. The engine owns the STRUCTURE and pagination; a template owns the
 * LOOK. Content flows across as many A4 pages as it needs (short prompt → 2-3
 * pages, rich prompt → 5+), so nothing is hardcoded to a fixed page count.
 *
 * Pagination model: the cover is one full-bleed A4 page (`@page :first` drops its
 * margin); everything after flows continuously inside per-page margins, with
 * break-inside:avoid only on ATOMIC units (a single card, itinerary row, the
 * pricing table, the footer). We never wrap whole sections in avoid-break — that
 * is what produced near-empty pages before.
 */
import { searchPhotos, routeMapUrl, qrUrl, geocode, staticMapUrl } from '../assets.js';
import { findCountry, renderCountryFramed, countryBbox, type LL, type Feat, type Rect, type TileColors } from './geomap.js';
import type {
  BrochureCard,
  BrochureContent,
  BrochureKV,
  BrochureSection,
  BrochureTemplate,
} from './types.js';

// ----------------------------------------------------------------------------
// Text + colour utilities
// ----------------------------------------------------------------------------

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string): RGB | null {
  const h = String(hex || '').replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toHex({ r, g, b }: RGB): string {
  const c = (x: number) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function mix(hex: string, withHex: string, ratio: number): string {
  const a = parseHex(hex);
  const b = parseHex(withHex);
  if (!a || !b) return hex;
  return toHex({
    r: a.r + (b.r - a.r) * ratio,
    g: a.g + (b.g - a.g) * ratio,
    b: a.b + (b.b - a.b) * ratio,
  });
}

export const darken = (hex: string, r: number): string => mix(hex, '#000000', r);
export const lighten = (hex: string, r: number): string => mix(hex, '#ffffff', r);

/** Relative luminance → pick readable text (#fff or near-black) over a colour. */
export function contrastInk(hex: string): string {
  const c = parseHex(hex);
  if (!c) return '#ffffff';
  const lum = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
  return lum > 0.62 ? '#15151c' : '#ffffff';
}

/** Validate/normalise an accent; fall back to a tasteful red if the model lies. */
export function normalizeAccent(hex?: string): string {
  return parseHex(hex || '') ? toHex(parseHex(hex || '')!) : '#E4002B';
}

// ----------------------------------------------------------------------------
// Fonts
// ----------------------------------------------------------------------------

function fontParam(name: string): string {
  return name.trim().replace(/\s+/g, '+');
}

/** Google Fonts <link> for the template's display + body faces (broad weights). */
function fontsLink(display: string, body: string): string {
  const fams =
    display.trim().toLowerCase() === body.trim().toLowerCase()
      ? `family=${fontParam(display)}:wght@300;400;500;600;700;800;900`
      : `family=${fontParam(display)}:wght@500;600;700;800;900&family=${fontParam(body)}:wght@300;400;500;600;700`;
  return `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?${fams}&display=swap" rel="stylesheet">`;
}

/**
 * Editorial fonts link — like fontsLink but ALSO requests the display face's
 * ITALIC axis (the editorial look leans on real italics for the masthead final
 * word, the pull-quote, numerals and the heading "&"). Without ital@1 Chromium
 * synthesises a fake oblique that reads cheap, so we load the genuine cut.
 */
function fontsLinkEditorial(display: string, body: string): string {
  const d = fontParam(display);
  const b = fontParam(body);
  const fams = `family=${d}:ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,600;1,700&family=${b}:wght@300;400;500;600;700`;
  return `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?${fams}&display=swap" rel="stylesheet">`;
}

// ----------------------------------------------------------------------------
// Theme resolution — template.theme(accent) merged over computed defaults
// ----------------------------------------------------------------------------

function resolveThemeVars(tpl: BrochureTemplate, accent: string, accent2?: string): string {
  const overrides = tpl.theme(accent, accent2) || {};
  const ovAccent = overrides['--accent'];
  const a: string = ovAccent && parseHex(ovAccent) ? ovAccent : accent;
  const defaults: Record<string, string> = {
    '--accent': a,
    '--accent-dark': darken(a, 0.26),
    '--accent-soft': lighten(a, 0.4),
    '--accent-wash': lighten(a, 0.92),
    '--accent-tint': lighten(a, 0.74),
    '--accent-contrast': contrastInk(a),
    '--ink': '#15151c',
    '--bg': '#ffffff',
    '--surface': '#faf7f2',
    '--line': '#e7e1d8',
    '--muted': '#74747f',
    '--cover-bg': '#15151c',
    '--display': `'${tpl.fonts.display}', Georgia, 'Times New Roman', serif`,
    '--body': `'${tpl.fonts.body}', system-ui, -apple-system, sans-serif`,
  };
  const merged = { ...defaults, ...overrides };
  return `:root{${Object.entries(merged)
    .map(([k, v]) => `${k}:${v}`)
    .join(';')}}`;
}

// ----------------------------------------------------------------------------
// Base CSS — reset, pagination, every cover mode, and all components.
// Entirely var-driven so each template only re-skins via theme() + its own css.
// ----------------------------------------------------------------------------

const BASE_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
@page{size:A4;margin:14mm 15mm}
@page :first{margin:0}
html,body{background:var(--bg)}
body{font-family:var(--body);color:var(--ink);font-size:13.5px;line-height:1.55;-webkit-print-color-adjust:exact;print-color-adjust:exact;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:var(--display);line-height:1.05}
img{display:block;max-width:100%}
.kicker{font-size:10.5px;letter-spacing:.28em;text-transform:uppercase;color:var(--accent);font-weight:700}
.sec{font-size:29px;font-weight:800;margin:5px 0 15px;letter-spacing:-.01em;line-height:1.05;color:var(--ink)}
.sec .rule{display:block;width:52px;height:4px;background:var(--accent);margin-top:9px;border-radius:2px}
.section{margin:0 0 11mm}
.section:last-child{margin-bottom:0}

/* ---- COVER (shared frame) ---- */
.cover{position:relative;width:210mm;height:297mm;overflow:hidden;page-break-after:always;color:#fff;background:var(--cover-bg)}
.cover .hero{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.cover .veil{position:absolute;inset:0}
.cover .top{position:absolute;top:15mm;left:18mm;right:18mm;display:flex;justify-content:space-between;font-size:10.5px;letter-spacing:.22em;text-transform:uppercase;opacity:.95;z-index:3}
.cover .pre{font-size:11px;letter-spacing:.4em;text-transform:uppercase;opacity:.92}
.cover h1{font-weight:800;letter-spacing:-.01em;text-shadow:0 2px 30px rgba(0,0,0,.35)}
.cover .sub{font-weight:300;letter-spacing:.04em}
.cover .route{font-size:11.5px;letter-spacing:.24em;text-transform:uppercase;opacity:.92}
.cover .bottom{position:absolute;bottom:0;left:0;right:0;padding:14mm 18mm;display:flex;justify-content:space-between;align-items:flex-end;z-index:3}
.cover .agency{font-size:12.5px;letter-spacing:.03em;line-height:1.5}
.cover .agency b{font-weight:700;font-size:14.5px}
.badge{background:var(--accent);color:var(--accent-contrast);border-radius:999px;padding:10px 19px;font-size:10.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}

/* photo-sun + gradient-veil + wash share a centred/bottom lockup */
.cv-photo-sun .veil{background:linear-gradient(180deg,rgba(8,8,14,.30),rgba(8,8,14,.08) 40%,rgba(8,8,14,.55) 72%,rgba(8,8,14,.85))}
.cv-photo-sun .disc{position:absolute;top:74mm;left:50%;transform:translateX(-50%);width:120mm;height:120mm;border-radius:50%;background:var(--accent);opacity:.9;z-index:2}
.cv-photo-sun .center{position:absolute;top:104mm;left:0;right:0;text-align:center;padding:0 16mm;z-index:3}
.cv-photo-sun h1{font-size:76px;margin:11px 0}
.cv-photo-sun .sub{font-size:18px}
.cv-photo-sun .route{margin-top:11px}

.cv-gradient-veil .veil{background:linear-gradient(180deg,rgba(8,8,14,.15),rgba(8,8,14,.05) 35%,rgba(8,8,14,.6) 72%,rgba(8,8,14,.92))}
.cv-gradient-veil .center{position:absolute;left:18mm;right:18mm;bottom:42mm;z-index:3}
.cv-gradient-veil h1{font-size:74px;margin:8px 0}
.cv-gradient-veil .sub{font-size:18px}
.cv-gradient-veil .route{margin-top:10px;color:var(--accent-soft)}
.cv-gradient-veil .accentbar{position:absolute;left:18mm;bottom:38mm;width:64mm;height:5px;background:var(--accent);z-index:3;border-radius:2px}

.cv-wash .veil{background:linear-gradient(150deg,var(--accent) 0%,rgba(255,255,255,.0) 55%),linear-gradient(0deg,rgba(255,255,255,.92),rgba(255,255,255,.25) 45%,rgba(255,255,255,.05))}
.cv-wash{color:var(--ink)}
.cv-wash .center{position:absolute;left:20mm;right:20mm;bottom:46mm;z-index:3}
.cv-wash h1{font-size:70px;margin:8px 0;color:var(--ink)}
.cv-wash .sub{font-size:18px;color:var(--ink)}
.cv-wash .route{margin-top:10px;color:var(--accent)}
.cv-wash .agency,.cv-wash .top{color:var(--ink)}

/* editorial-split: photo top ~58%, solid colour band below with side lockup */
.cv-editorial-split .hero{height:60%}
.cv-editorial-split .band2{position:absolute;left:0;right:0;bottom:0;height:40%;background:var(--cover-bg)}
.cv-editorial-split .center{position:absolute;left:18mm;right:18mm;bottom:42mm;z-index:3}
.cv-editorial-split h1{font-size:66px;margin:8px 0}
.cv-editorial-split .sub{font-size:17px}
.cv-editorial-split .route{margin-top:10px;color:var(--accent-soft)}
.cv-editorial-split .rule2{position:absolute;left:18mm;bottom:38mm;width:60mm;height:4px;background:var(--accent);z-index:3}

/* poster-band: flat colour cover, big centred wordmark, no photo veil dependence */
.cv-poster-band{background:var(--cover-bg)}
.cv-poster-band .hero{opacity:.9;mix-blend-mode:luminosity}
.cv-poster-band .veil{background:linear-gradient(180deg,var(--accent) 0,rgba(0,0,0,0) 28%,rgba(0,0,0,0) 70%,var(--accent) 100%);opacity:.85}
.cv-poster-band .center{position:absolute;top:50%;left:0;right:0;transform:translateY(-50%);text-align:center;padding:0 16mm;z-index:3}
.cv-poster-band h1{font-size:72px;margin:10px 0;text-transform:uppercase;letter-spacing:.02em}
.cv-poster-band .sub{font-size:16px;letter-spacing:.06em}
.cv-poster-band .route{margin-top:12px}
.cv-poster-band .frame{position:absolute;inset:9mm;border:2px solid rgba(255,255,255,.7);z-index:3;pointer-events:none}

/* deco-arch: symmetric arch frame */
.cv-deco-arch .veil{background:linear-gradient(180deg,rgba(0,0,0,.45),rgba(0,0,0,.2) 40%,rgba(0,0,0,.75))}
.cv-deco-arch .arch{position:absolute;top:24mm;left:50%;transform:translateX(-50%);width:150mm;height:210mm;border:3px solid var(--accent);border-radius:75mm 75mm 0 0;z-index:2}
.cv-deco-arch .center{position:absolute;top:96mm;left:0;right:0;text-align:center;padding:0 26mm;z-index:3}
.cv-deco-arch h1{font-size:60px;margin:10px 0;letter-spacing:.04em}
.cv-deco-arch .sub{font-size:16px;letter-spacing:.08em}
.cv-deco-arch .route{margin-top:12px;color:var(--accent-soft)}

/* minimal-type: type-led, photo as a small framed strip */
.cv-minimal-type{background:var(--bg);color:var(--ink)}
.cv-minimal-type .hero{position:absolute;inset:auto 0 0 0;top:62%;height:38%}
.cv-minimal-type .center{position:absolute;top:30mm;left:20mm;right:20mm;z-index:3}
.cv-minimal-type h1{font-size:66px;margin:10px 0;color:var(--ink)}
.cv-minimal-type .sub{font-size:18px;color:var(--muted)}
.cv-minimal-type .route{margin-top:12px;color:var(--accent)}
.cv-minimal-type .top,.cv-minimal-type .agency{color:var(--ink)}
.cv-minimal-type .mark{position:absolute;top:30mm;right:20mm;width:16mm;height:16mm;border-radius:50%;background:var(--accent);z-index:3}

/* bold-blocks: oversized headline over hard colour blocks */
.cv-bold-blocks{background:var(--cover-bg)}
.cv-bold-blocks .hero{height:55%}
.cv-bold-blocks .blocks{position:absolute;left:0;right:0;bottom:0;height:45%;background:var(--accent)}
.cv-bold-blocks .center{position:absolute;left:16mm;right:16mm;bottom:34mm;z-index:3}
.cv-bold-blocks h1{font-size:84px;margin:6px 0;line-height:.92;text-transform:uppercase;letter-spacing:-.02em;color:var(--accent-contrast)}
.cv-bold-blocks .sub{font-size:18px;color:var(--accent-contrast);opacity:.92}
.cv-bold-blocks .route{margin-top:10px;color:var(--accent-contrast);opacity:.85}
.cv-bold-blocks .agency,.cv-bold-blocks .badge{color:var(--accent-contrast)}

/* filmstrip: hero + a thin strip of frames at the bottom */
.cv-filmstrip .veil{background:linear-gradient(180deg,rgba(8,8,14,.25),rgba(8,8,14,.05) 40%,rgba(8,8,14,.8))}
.cv-filmstrip .center{position:absolute;left:18mm;right:18mm;bottom:60mm;z-index:3}
.cv-filmstrip h1{font-size:70px;margin:8px 0}
.cv-filmstrip .sub{font-size:17px}
.cv-filmstrip .route{margin-top:10px;color:var(--accent-soft)}
.cv-filmstrip .strip{position:absolute;left:0;right:0;bottom:18mm;height:30mm;display:flex;gap:3mm;padding:0 18mm;z-index:3}
.cv-filmstrip .strip span{flex:1;border-radius:5px;background-size:cover;background-position:center;border:2px solid rgba(255,255,255,.5)}

/* passport: boxed "stamp" lockup centred over hero */
.cv-passport .veil{background:linear-gradient(180deg,rgba(8,8,14,.4),rgba(8,8,14,.25) 50%,rgba(8,8,14,.7))}
.cv-passport .box{position:absolute;top:88mm;left:50%;transform:translateX(-50%);width:150mm;padding:18mm 16mm;text-align:center;border:2px solid var(--accent);background:rgba(10,10,16,.42);z-index:3}
.cv-passport .center{position:static}
.cv-passport h1{font-size:58px;margin:10px 0}
.cv-passport .sub{font-size:16px;letter-spacing:.06em}
.cv-passport .route{margin-top:11px;color:var(--accent-soft)}

/* ---- INTRO BAND ---- */
.band{background:var(--accent);color:var(--accent-contrast);padding:28px 32px;border-radius:12px;break-inside:avoid}
.band .kicker{color:var(--accent-contrast);opacity:.85}
.band h2{font-size:26px;font-weight:800;margin:7px 0 9px;line-height:1.12}
.band p{font-size:14px;line-height:1.62;opacity:.97;max-width:150mm}

/* ---- HIGHLIGHTS GRID ---- */
.grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
.card{position:relative;height:50mm;border-radius:11px;overflow:hidden;background:linear-gradient(135deg,var(--accent-wash),var(--accent-tint));break-inside:avoid}
.card img{width:100%;height:100%;object-fit:cover}
.card .cap{position:absolute;left:0;right:0;bottom:0;padding:20px 13px 11px;background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.78));color:#fff;font-size:13.5px;font-weight:600}
.card .cap small{display:block;font-weight:400;opacity:.85;font-size:10.5px;margin-top:1px}
.card.stat{background:linear-gradient(135deg,var(--accent),var(--accent-dark));display:flex;align-items:center;justify-content:center;text-align:center}
.card.stat .big{font-family:var(--display);font-size:34px;font-weight:800;color:var(--accent-contrast)}
.card.stat .lab{font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--accent-contrast);opacity:.9;margin-top:2px}

/* ---- ITINERARY (timeline) ---- */
.itin{list-style:none;border-left:2px solid var(--line);margin:2px 0 0 4px}
.itin li{position:relative;padding:0 0 12px 24px;break-inside:avoid}
.itin li:last-child{padding-bottom:0}
.itin li:before{content:'';position:absolute;left:-7px;top:3px;width:12px;height:12px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px var(--bg)}
.itin .d{font-family:var(--display);font-weight:700;font-size:14.5px;color:var(--accent)}
.itin .t{font-size:12.5px;line-height:1.5;color:var(--ink);opacity:.86;margin-top:2px}

/* ---- ROUTE MAP ---- */
.map{width:100%;border-radius:11px;overflow:hidden;border:1px solid var(--line);margin-top:2px}
.map img{width:100%}

/* ---- INCLUSIONS / GRID SECTIONS ---- */
.incl{display:grid;grid-template-columns:1fr 1fr;gap:14px 28px}
.incl .row{display:flex;gap:12px;align-items:baseline;break-inside:avoid}
.incl .k{font-weight:700;color:var(--accent);min-width:30mm;font-size:12px}
.incl .v{font-size:12.5px;line-height:1.45;color:var(--ink);opacity:.9}

/* ---- PROSE SECTIONS ---- */
.prose p{font-size:13.5px;line-height:1.66;max-width:165mm}
.prose ul{margin:10px 0 0 0;list-style:none}
.prose li{position:relative;padding:0 0 7px 18px;font-size:13px;line-height:1.5}
.prose li:before{content:'';position:absolute;left:0;top:7px;width:7px;height:7px;border-radius:50%;background:var(--accent)}

/* ---- PRICING ---- */
table.pricing{width:100%;border-collapse:collapse;border:1px solid var(--line);border-radius:10px;overflow:hidden;break-inside:avoid}
table.pricing th{background:var(--accent);color:var(--accent-contrast);text-align:left;padding:12px 18px;font-size:12px;letter-spacing:.05em;text-transform:uppercase}
table.pricing td{padding:12px 18px;border-top:1px solid var(--line);font-size:13.5px}
table.pricing td.lbl{font-weight:600;background:var(--accent-wash);width:46%}
table.pricing td.amt{font-family:var(--display);font-weight:700}
.pricing-note{font-size:11.5px;color:var(--muted);margin-top:8px}

/* ---- FOOTER ---- */
.footer{background:var(--ink);color:#fff;border-radius:14px;padding:24px 30px;display:flex;justify-content:space-between;align-items:center;gap:22px;break-inside:avoid}
.footer .cta{font-family:var(--display);font-size:22px;font-weight:700;line-height:1.2}
.footer .cta .em{color:var(--accent-soft)}
.footer .meta{font-size:12px;line-height:1.8;margin-top:9px;opacity:.92}
.footer .soc{display:flex;gap:11px;margin-top:10px}
.footer .soc img{width:18px;height:18px}
.footer .qr{background:#fff;padding:8px;border-radius:9px;flex-shrink:0}
.footer .qr img{width:32mm;height:32mm}
`;

// ----------------------------------------------------------------------------
// Cover builder
// ----------------------------------------------------------------------------

function coverInner(c: BrochureContent, hero: string, stripUrls: string[]): string {
  const heroImg = hero ? `<img class="hero" src="${esc(hero)}" alt="">` : '';
  const top = `<div class="top"><span>${esc(c.topLeft || c.agencyName || '')}</span><span>${esc(c.topRight || '')}</span></div>`;
  const lockup =
    `<div class="center">` +
    (c.preTitle ? `<div class="pre">${esc(c.preTitle)}</div>` : '') +
    `<h1>${esc(c.title)}</h1>` +
    (c.subtitle ? `<div class="sub">${esc(c.subtitle)}</div>` : '') +
    (c.routeLine ? `<div class="route">${esc(c.routeLine)}</div>` : '') +
    `</div>`;
  const bottom =
    `<div class="bottom">` +
    `<div class="agency">${c.agencyName ? `<b>${esc(c.agencyName)}</b><br>` : ''}${esc(c.agencyLine || '')}</div>` +
    (c.badge ? `<div class="badge">${esc(c.badge)}</div>` : '') +
    `</div>`;

  const mode = c.__mode || 'photo-sun';
  let extra = '';
  if (mode === 'photo-sun') extra = `<div class="disc"></div>`;
  else if (mode === 'gradient-veil') extra = `<div class="accentbar"></div>`;
  else if (mode === 'editorial-split') extra = `<div class="band2"></div><div class="rule2"></div>`;
  else if (mode === 'poster-band') extra = `<div class="frame"></div>`;
  else if (mode === 'deco-arch') extra = `<div class="arch"></div>`;
  else if (mode === 'minimal-type') extra = `<div class="mark"></div>`;
  else if (mode === 'bold-blocks') extra = `<div class="blocks"></div>`;
  else if (mode === 'filmstrip') {
    const frames = stripUrls.slice(0, 4).map((u) => `<span style="background-image:url('${esc(u)}')"></span>`).join('');
    extra = `<div class="strip">${frames}</div>`;
  }

  // passport wraps the lockup in a box
  if (mode === 'passport') {
    return (
      heroImg +
      `<div class="veil"></div>` +
      top +
      `<div class="box">` +
      (c.preTitle ? `<div class="pre">${esc(c.preTitle)}</div>` : '') +
      `<h1>${esc(c.title)}</h1>` +
      (c.subtitle ? `<div class="sub">${esc(c.subtitle)}</div>` : '') +
      (c.routeLine ? `<div class="route">${esc(c.routeLine)}</div>` : '') +
      `</div>` +
      bottom
    );
  }

  return heroImg + `<div class="veil"></div>` + extra + top + lockup + bottom;
}

// ----------------------------------------------------------------------------
// Section renderers
// ----------------------------------------------------------------------------

function head(kicker?: string, heading?: string): string {
  return (
    (kicker ? `<div class="kicker">${esc(kicker)}</div>` : '') +
    (heading ? `<h2 class="sec">${esc(heading)}<span class="rule"></span></h2>` : '')
  );
}

function cardHtml(card: BrochureCard, url: string): string {
  const inner = url
    ? `<img src="${esc(url)}" alt="">`
    : '';
  const cap =
    `<div class="cap">${esc(card.label)}` +
    (card.caption ? `<small>${esc(card.caption)}</small>` : '') +
    `</div>`;
  return `<div class="card">${inner}${cap}</div>`;
}

function gridHtml(cards: BrochureCard[], urls: string[], stat?: { big: string; label: string }): string {
  const cells = cards.map((c, i) => cardHtml(c, urls[i] || ''));
  if (stat) cells.push(`<div class="card stat"><div><div class="big">${esc(stat.big)}</div><div class="lab">${esc(stat.label)}</div></div></div>`);
  return `<div class="grid">${cells.join('')}</div>`;
}

function inclHtml(items: BrochureKV[]): string {
  return `<div class="incl">${items
    .map((r) => `<div class="row"><div class="k">${esc(r.k)}</div><div class="v">${esc(r.v)}</div></div>`)
    .join('')}</div>`;
}

// ----------------------------------------------------------------------------
// Asset fetching
// ----------------------------------------------------------------------------

const MAX_PHOTOS = 16;

async function pick(query?: string): Promise<string> {
  if (!query || !query.trim()) return '';
  try {
    const r = await searchPhotos(query, 1);
    return r[0]?.url ?? '';
  } catch {
    return '';
  }
}

/** Fetch up to `n` CANDIDATE photo URLs for a query (one API call). Returning several
 *  candidates per slot lets the caller assign a UNIQUE photo to each slot — so the same
 *  image is never reused across the cover, rail, section cards or fillers. */
async function searchCandidates(query: string | undefined, n = 6): Promise<string[]> {
  if (!query || !query.trim()) return [];
  try {
    const r = await searchPhotos(query, n);
    return r.map((x) => x.url).filter((u): u is string => !!u);
  } catch {
    return [];
  }
}

/** Build a unique-photo assigner over a shared used-set: `take` returns the first
 *  candidate not yet used (and marks it); `pool` collects all still-unused candidates as
 *  a spare pool for page fillers. */
function uniquePhotoAssigner() {
  const used = new Set<string>();
  const take = (cands: string[]): string => {
    for (const u of cands) if (!used.has(u)) { used.add(u); return u; }
    return '';
  };
  const pool: string[] = [];
  const addPool = (cands: string[]) => {
    for (const u of cands) if (!used.has(u) && !pool.includes(u)) pool.push(u);
  };
  return { used, take, pool, addPool };
}

/** Generic destination-scenery queries for FILLER imagery used to close sparse
 *  pages with a photo instead of a flat brand box. Derived from the route/title so
 *  it adapts to ANY trip (never per-prompt tailored). Prefers the later stops so a
 *  filler shows a different locale than the cover hero. */
function fillerImageQueries(c: BrochureContent): string[] {
  const out: string[] = [];
  const places = (c.route?.places ?? []).map((p) => p?.name).filter((n): n is string => !!n);
  const names = (places.length ? places : routeCities(c)).filter(Boolean);
  for (const n of names.slice(-3).reverse()) out.push(`${n} landscape`);
  if (c.route?.headline) out.push(String(c.route.headline));
  if (c.title) out.push(String(c.title));
  return Array.from(new Set(out.map((s) => s.trim()).filter(Boolean))).slice(0, 3);
}

/** Parse a partial/messy LLM reply into BrochureContent, or null if not JSON. */
export function parseBrochureContent(raw: string): BrochureContent | null {
  if (!raw) return null;
  let s = raw.trim();
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  // 1) Direct parse — a clean object, OR a top-level array wrapper [ {…} ] that
  //    some models emit despite the "no wrapper" contract. pickBrochureObject
  //    collapses an array to its most content-rich element.
  const direct = pickBrochureObject(tryParseJson(s));
  if (direct) return coerceContent(direct);
  // 2) Salvage: slice the outermost {...} or [...] substring out of any
  //    surrounding prose/fences and retry. Prefer whichever bracket opens first
  //    (it is the outermost container).
  const objStart = s.indexOf('{');
  const objEnd = s.lastIndexOf('}');
  const arrStart = s.indexOf('[');
  const arrEnd = s.lastIndexOf(']');
  const candidates: string[] = [];
  if (arrStart >= 0 && arrEnd > arrStart && (objStart < 0 || arrStart < objStart)) {
    candidates.push(s.slice(arrStart, arrEnd + 1));
  }
  if (objStart >= 0 && objEnd > objStart) candidates.push(s.slice(objStart, objEnd + 1));
  for (const cand of candidates) {
    const o = pickBrochureObject(tryParseJson(cand));
    if (o) return coerceContent(o);
  }
  return null;
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Normalize a parsed JSON value to the brochure object. An object is taken as-is;
 * an array (the model wrapped the single object in `[ … ]`) collapses to its most
 * content-rich element — picking is safe where merging would be risky. Anything
 * else → null.
 */
function pickBrochureObject(parsed: unknown): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== 'object') return null;
  if (Array.isArray(parsed)) {
    const objs = parsed.filter(
      (x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x),
    );
    if (!objs.length) return null;
    return objs
      .map((o) => ({
        o,
        score:
          ('palette' in o ? 4 : 0) +
          ('title' in o ? 4 : 0) +
          ('itinerary' in o || 'route' in o || 'sections' in o ? 2 : 0) +
          Object.keys(o).length,
      }))
      .sort((a, b) => b.score - a.score)[0]!.o;
  }
  return parsed as Record<string, unknown>;
}

/**
 * A heading that merely echoes a RENDERING DIRECTIVE, not brochure content — the
 * engine draws the map and places the logo itself; the design-style line is
 * guidance. Single source of truth, shared by coerceContent (composer output) AND
 * the backstop paths (ensureBriefCoverage / buildFallbackBrochureContent) so a
 * directive can never leak into the PDF as a prose section by any route.
 */
const DIRECTIVE_HEADING_RE = /^(map|route ?map|the route|logo|logo ?placement|design|design ?style)$/i;
function isDirectiveHeading(h: string): boolean {
  return DIRECTIVE_HEADING_RE.test(String(h || '').trim());
}

/**
 * A section that is INTERNAL SCAFFOLDING, not brochure content — the orchestrator
 * threads the specialists' research notes, the copywriter's draft, and the raw user
 * brief into the composer's task as "SOURCE MATERIAL" to SYNTHESIZE; a literal model
 * sometimes dumps that scaffolding straight back as `sections[]` (headings like
 * "Research Notes", "Copywriter Copy", "Raw User Details Verbatim", kicker "SOURCE
 * CONTENT"). That must NEVER reach the PDF. Deterministic backstop at the parse choke
 * point so it's caught regardless of model or template family — the prompt hardening
 * lowers the rate, this guarantees the floor.
 */
const SCAFFOLD_RE =
  /\b(source (content|material|notes?)|research notes?|copywriter('?s)? (copy|notes?|draft)|raw (user )?details?|raw brief|brief verbatim|agent (notes?|output|logs?)|specialist (notes?|output)|working notes?|internal notes?|photo[- ]?(search(es)?|guide|quer(y|ies)|prompts?)|image[- ]?search(es)?|search quer(y|ies)|render[- ]?engine|engine prompts?|suggested (image|photo)s?)\b/i;
function isScaffoldSection(s: any): boolean {
  const h = String(s?.heading || '').trim();
  const k = String(s?.kicker || '').trim();
  return SCAFFOLD_RE.test(h) || SCAFFOLD_RE.test(k) || /\bverbatim\b/i.test(h);
}

/**
 * Footer contact lines. The Brand Kit is the AUTHORITATIVE source of agency identity:
 * when it supplies contacts, use ONLY those — the composer's contact lines are either
 * redundant (the brief repeated them) or, when the brief omits contacts, FABRICATED
 * (the model invents an agency name + website and drops them in as contact lines). So
 * brand contacts WIN exclusively; the composer's are used only when the kit has none.
 */
function footerContactLines(c: BrochureContent): string[] {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const src = c.__brand?.contact?.length ? c.__brand.contact : (c.footer?.contactLines ?? []);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of src) {
    const v = String(l ?? '').trim();
    if (!v || seen.has(norm(v))) continue;
    seen.add(norm(v));
    out.push(v);
  }
  return out.slice(0, 4);
}

/** Footer social slugs — Brand-Kit socials win exclusively when set (same reasoning). */
function footerSocials(c: BrochureContent): string[] {
  const src = c.__brand?.socials?.length ? c.__brand.socials : (c.footer?.social ?? []);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of src) {
    const v = String(s ?? '').trim().toLowerCase();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out.slice(0, 6);
}

/**
 * The Brand Kit owns the agency identity. When the kit supplies a name / logo /
 * contacts, suppress the composer's agency fields — otherwise a brief that omits
 * AGENCY makes the model HALLUCINATE one (a fake agency name + "X presents" line +
 * a made-up website) that then clashes with the real brand on the cover/footer. The
 * brand's name (or logo) already renders as the cover brandmark, so we just clear the
 * composer's invented agencyName / agencyLine and strip any "presents"/URL pre-title.
 */
function applyBrandIdentity(c: BrochureContent): void {
  const b = c.__brand;
  const hasIdentity = !!(b && (b.name?.trim() || b.logoUrl || b.contact?.length));
  if (!hasIdentity) return;
  const o = c as any;
  o.agencyName = '';
  o.agencyLine = '';
  const fabricated = /\bpresents\b|https?:\/\/|www\.|\.(com|in|org|net)\b/i;
  if (c.preTitle && fabricated.test(c.preTitle)) o.preTitle = '';
  if (c.badge && fabricated.test(c.badge)) o.badge = '';
  if (c.topLeft && fabricated.test(c.topLeft)) o.topLeft = '';
  if (c.topRight && fabricated.test(c.topRight)) o.topRight = '';
}

/**
 * Map a parsed object into BrochureContent, salvaging common LLM deviations:
 * unwrap a single container key (e.g. {brochure:{…}}), and pull the accent from
 * alternative key names. Defensive only — the composer prompt is the real cure.
 */
function coerceContent(raw: Record<string, unknown>): BrochureContent {
  let o = raw;
  // Unwrap an obvious single-container shape: {brochure|content|data: {real…}}.
  for (const key of ['brochure', 'content', 'data', 'brochureContent']) {
    const inner = o[key];
    if (inner && typeof inner === 'object' && !Array.isArray(inner) && !o['title']) {
      o = inner as Record<string, unknown>;
      break;
    }
  }
  const anyO = o as any;
  // Salvage the accent from alternative key names the model sometimes invents.
  const palette = (anyO.palette && typeof anyO.palette === 'object' ? anyO.palette : {}) as Record<string, unknown>;
  if (!palette['accent']) {
    const alt =
      anyO.accentColor ||
      anyO.accent ||
      palette['accentColor'] ||
      anyO.destinationNotes?.accentColor ||
      anyO.colors?.accent;
    if (typeof alt === 'string') palette['accent'] = alt;
  }
  anyO.palette = palette;
  if (typeof anyO.title !== 'string' || !anyO.title.trim()) anyO.title = 'Your Journey';
  // Drop sections that merely echo a rendering DIRECTIVE (the engine draws the map
  // and places the logo itself; the design-style line is guidance, not content), AND
  // sections that are internal SCAFFOLDING the model dumped instead of synthesizing
  // (research notes / copywriter copy / raw user details). Neither is brochure content.
  if (Array.isArray(anyO.sections)) {
    anyO.sections = anyO.sections.filter((s: any) => !isDirectiveHeading(s?.heading) && !isScaffoldSection(s));
  }
  // Drop a CTA sub-line that merely repeats the CTA — a common composer slip that
  // printed the same line twice on the closing page (e.g. "LIMITED SEATS — BOOK BY …").
  if (anyO.footer && typeof anyO.footer === 'object') {
    const f = anyO.footer as Record<string, unknown>;
    const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (f.ctaSub && f.cta && norm(f.ctaSub) === norm(f.cta)) delete f.ctaSub;
  }
  return o as unknown as BrochureContent;
}

/**
 * LAST-RESORT content. When the composer twice fails to emit usable JSON, build a
 * faithful brochure straight from the user's brief so the run ALWAYS yields a real
 * PDF — never a "no content" dead-end. Fully generic: it splits the brief into its
 * ALL-CAPS "LABEL:" blocks, lifts the obvious cover/intro fields, and turns every
 * remaining block into a prose section so NOTHING the user wrote is lost. The text
 * is escaped downstream like any other content.
 */
/** Parse a DAY BY DAY block into structured days. Handles both inline
 *  ("Day 1 — …: … Day 2 — …: …") and newline-separated styles; strips the
 *  "Day N —" prefix (the engine numbers days itself) so the title is the place. */
function fbParseDays(body: string): { title: string; text: string }[] {
  const txt = cleanBrief(body).replace(/\n+/g, ' ').trim();
  const parts = txt.split(/(?=\bDay\s+\d+\b\s*[—–:-])/i).map((s) => s.trim()).filter(Boolean);
  const days: { title: string; text: string }[] = [];
  for (const p of parts) {
    const m = p.match(/^Day\s+\d+\s*[—–-]?\s*([^:]*?):\s*(.+)$/i);
    if (m) {
      days.push({ title: (m[1] || '').trim() || `Day ${days.length + 1}`, text: (m[2] || '').trim() });
    } else {
      const t = p.replace(/^Day\s+\d+\s*[—–-]?\s*/i, '').trim();
      if (t) days.push({ title: t.slice(0, 80), text: '' });
    }
  }
  return days.slice(0, 40);
}

/** Split a block into "Capitalised Label: value" pairs (inline OR multiline) — used
 *  for INCLUSIONS (→ a spec grid) and the labelled rows of PRICING. */
function fbParseKV(body: string): { k: string; v: string }[] {
  const txt = cleanBrief(body).replace(/\n+/g, ' ').trim();
  const parts = txt.split(/(?=[A-Z][A-Za-z'&./ ]{1,28}:\s)/).map((s) => s.trim()).filter(Boolean);
  const kv: { k: string; v: string }[] = [];
  for (const p of parts) {
    const m = p.match(/^([A-Z][A-Za-z'&./ ]{1,28}):\s*(.+)$/);
    if (m) kv.push({ k: m[1]!.trim(), v: m[2]!.trim().slice(0, 200) });
  }
  return kv.slice(0, 12);
}

/** PRICING → rows: any leading bare amount becomes an emphasised headline row, then
 *  the "Label: amount" pairs (Single Supplement, Deposit, …). */
function fbParsePriceRows(body: string): { label: string; value: string; emphasize?: boolean }[] {
  const txt = cleanBrief(body).replace(/\n+/g, ' ').trim();
  const parts = txt.split(/(?=[A-Z][A-Za-z'&./ ]{1,28}:\s)/).map((s) => s.trim()).filter(Boolean);
  const rows: { label: string; value: string; emphasize?: boolean }[] = [];
  let headline = '';
  for (const p of parts) {
    const m = p.match(/^([A-Z][A-Za-z'&./ ]{1,28}):\s*(.+)$/);
    if (m) rows.push({ label: m[1]!.trim(), value: m[2]!.trim().slice(0, 80) });
    else headline = (headline ? headline + ' ' : '') + p;
  }
  if (headline.trim()) rows.unshift({ label: 'Price', value: headline.trim().slice(0, 90), emphasize: true });
  return rows.slice(0, 6);
}

/** "Tokyo → Hakone → Kyoto → Nara → Osaka" → ["Tokyo","Hakone",…] for the map. */
function fbRouteCities(routeLine: string): string[] {
  return routeLine
    .split(/→|->|—|–|>|,/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12);
}

export function buildFallbackBrochureContent(goal: string): BrochureContent {
  const blocks = splitBriefBlocks(goal || '');
  const find = (...names: string[]): string => {
    const want = names.map((n) => n.toLowerCase());
    const b = blocks.find((x) => want.some((w) => x.heading.toLowerCase().includes(w)));
    return b ? b.body : '';
  };
  const firstLine = (s: string): string => cleanBrief((s.split('\n').find((l) => l.trim()) ?? '').trim());

  const agency = firstLine(find('agency')).split(/[—–-]/)[0]!.trim();
  const tripLine = firstLine(find('trip'));
  let title = tripLine || firstLine(find('about the experience')) || 'Your Journey';
  // Split "Spirit of Japan — 8 Days · 5 Cities · Luxury" into title + subtitle.
  let subtitle = '';
  const dash = title.search(/\s[—–-]\s/);
  if (tripLine && dash > 0) {
    subtitle = title.slice(dash).replace(/^\s*[—–-]\s*/, '').trim();
    title = title.slice(0, dash).trim();
  }
  const tagline = firstLine(find('tagline'));
  const category = firstLine(find('category'));
  const duration = firstLine(find('duration'));
  if (!subtitle) subtitle = [duration, category].filter(Boolean).join(' · ');
  // ROUTE often carries a lowercase parenthetical ("ROUTE (in travel order):") that
  // the ALL-CAPS block splitter doesn't treat as a heading, so fall back to a direct
  // scan of the goal text for the route line.
  let routeBody = find('route');
  if (!routeBody) {
    const rm = (goal || '').match(/ROUTE[^:\n]*:\s*([^\n]+)/i);
    if (rm) routeBody = rm[1]!;
  }
  const routeLine = cleanBrief(routeBody).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  const aboutBody = cleanBrief(find('about the experience')).slice(0, 1100);

  // STRUCTURED extraction — the whole point of this upgrade: a composer failure must
  // still yield a real brochure (timeline, map, inclusions grid, pricing, footer),
  // not a wall of generic "Details" prose bands.
  const days = fbParseDays(find('day by day', 'day-by-day', 'itinerary'));
  const cities = routeLine ? fbRouteCities(routeLine) : [];
  const inclusions = fbParseKV(find('inclusions', 'inclusion'));
  const priceRows = fbParsePriceRows(find('pricing', 'price'));
  const heroQuery = cities[0] ? `${cities[0]} travel cityscape` : `${title} travel`;

  // Footer from CONTACT / CALL TO ACTION / SOCIAL — so the closing page is present.
  const footer: Record<string, unknown> = {};
  const contactBody = find('contact');
  if (contactBody) {
    const lines = cleanBrief(contactBody).split(/\n|·|\||;/).map((l) => l.trim()).filter(Boolean).slice(0, 4);
    if (lines.length) footer.contactLines = lines;
  }
  const cta = firstLine(find('call to action', 'cta'));
  if (cta) footer.cta = cta.slice(0, 120);
  const socialBody = find('social');
  if (socialBody) {
    const slugs = cleanBrief(socialBody)
      .split(/[,\n]/)
      .map((s) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, ''))
      .filter(Boolean)
      .slice(0, 6);
    if (slugs.length) footer.social = slugs;
  }
  const footerObj = footer.cta || footer.contactLines || footer.social ? footer : null;

  // Headings folded into structured fields above — everything ELSE (additional
  // services, dates/season, important info, etc.) becomes a section so NOTHING the
  // user wrote is lost.
  const consumed =
    /(create a premium|agency|^contact|website|address|social|^trip|category|target|tagline|group size|duration|accent|^route|about the experience|design style|logo placement|^map$|overview|day ?by ?day|inclusions?|pricing|^price|call ?to ?action|cta)/i;
  const sections = blocks
    .filter((b) => b.body && !consumed.test(b.heading.trim()) && !isDirectiveHeading(b.heading) && !isScaffoldSection({ heading: b.heading }))
    .map((b) => briefBlockToSection(b))
    .filter((s) => Boolean((s as any).body) || ((s as any).bullets?.length ?? 0) > 0);

  const content: Record<string, unknown> = {
    palette: { accent: '#1C3F94' },
    ...(agency ? { agencyName: agency } : {}),
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(tagline ? { tagline } : {}),
    ...(routeLine ? { routeLine } : {}),
    heroQuery,
    ...(aboutBody ? { intro: { kicker: 'About', heading: title, body: aboutBody } } : {}),
    ...(days.length ? { itinerary: { kicker: 'Day by day', heading: `Your ${days.length}-day journey`, days } } : {}),
    ...(cities.length >= 2 ? { route: { kicker: 'The route', heading: 'Your route', cities } } : {}),
    ...(inclusions.length ? { inclusions: { kicker: 'Inclusions', heading: "What's included", items: inclusions } } : {}),
    ...(priceRows.length ? { pricing: { kicker: 'Investment', heading: 'Pricing', rows: priceRows } } : {}),
    ...(footerObj ? { footer: footerObj } : {}),
    ...(sections.length ? { sections } : {}),
  };
  return content as unknown as BrochureContent;
}

/** Strip the brief's markdown/brackets without collapsing its paragraph breaks. */
function cleanBrief(s: string): string {
  return (s || '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) -> text
    .replace(/[[\]]/g, '') // stray [ ] wrappers
    .replace(/^\s*\*(.+?)\*\s*$/gm, '$1') // *emphasised note* -> note
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Title-case an ALL-CAPS brief heading: "LEARNING OUTCOMES" -> "Learning Outcomes". */
function titleCaseHeading(h: string): string {
  return h
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** A brief block → a prose section (bullets when the block is a bulleted list). */
function briefBlockToSection(b: { heading: string; body: string }): Record<string, unknown> {
  const lines = b.body.split('\n').map((l) => l.trim()).filter(Boolean);
  const bulletLines = lines.filter((l) => /^[•\-*]/.test(l));
  const heading = titleCaseHeading(b.heading);
  if (bulletLines.length >= 2 && bulletLines.length >= lines.length - 1) {
    const bullets = lines.map((l) => cleanBrief(l.replace(/^[•\-*]\s*/, ''))).filter(Boolean);
    return { kicker: 'Details', heading, layout: 'prose', bullets };
  }
  return { kicker: 'Details', heading, layout: 'prose', body: cleanBrief(b.body).slice(0, 1400) };
}

/**
 * Split a labelled brief into { heading, body } blocks. A heading is an ALL-CAPS
 * line (optionally ending ":"); everything until the next heading is its body.
 * Content before the first heading is grouped under "Overview".
 */
function splitBriefBlocks(text: string): { heading: string; body: string }[] {
  // A heading is either "LABEL:" with an optional INLINE value (briefs mix both
  // styles — "AGENCY: The Modern Classroom" on one line, but "TRIP:" with the value
  // on the next), or a bare ALL-CAPS line. Returns the inline value as the first
  // body line so it is never lost.
  const headingOf = (l: string): { heading: string; rest: string } | null => {
    const m = l.match(/^([A-Z][A-Z0-9 &',./()\-]{2,48}):\s*(.*)$/);
    if (m && m[1]) return { heading: m[1].trim(), rest: (m[2] ?? '').trim() };
    if (/^[A-Z][A-Z &]{4,48}$/.test(l)) return { heading: l.trim(), rest: '' };
    return null;
  };
  const out: { heading: string; body: string[] }[] = [];
  let cur: { heading: string; body: string[] } | null = null;
  for (const raw of (text || '').replace(/\r/g, '').split('\n')) {
    const l = raw.trim();
    const head = headingOf(l);
    if (head) {
      cur = { heading: head.heading, body: head.rest ? [head.rest] : [] };
      out.push(cur);
    } else if (cur) {
      cur.body.push(raw);
    } else if (l) {
      cur = { heading: 'Overview', body: [raw] };
      out.push(cur);
    }
  }
  return out
    .map((b) => ({ heading: b.heading, body: b.body.join('\n').trim() }))
    .filter((b) => b.heading);
}

const COVERAGE_STOP = new Set([
  'the', 'and', 'for', 'with', 'your', 'from', 'this', 'that', 'will', 'are', 'our', 'all', 'any',
  'per', 'each', 'into', 'about', 'their', 'they', 'student', 'students', 'before', 'after', 'than',
  'have', 'will', 'every', 'these', 'those', 'which', 'while', 'between', 'including',
]);
/** Directive / cover-meta / structurally-rendered headings that are NOT free body content. */
const COVERAGE_SKIP =
  /^(create a premium.*|overview|agency|contact|website|address|social|trip|category|target audience|tagline|group size|duration|accent ?colou?r?|accent|route|map|logo placement|design style|about the experience|day[ -]?by[ -]?day itinerary|itinerary|pricing|price)$/i;

function normalizeWords(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
}
function salientTokens(body: string): string[] {
  const words = normalizeWords(body)
    .split(' ')
    .filter((w) => w.length >= 5 && !COVERAGE_STOP.has(w));
  return [...new Set(words)].slice(0, 8);
}

/**
 * The text in which a brief block's words would ACTUALLY appear if the composer
 * rendered it — i.e. real prose only. Deliberately EXCLUDES search/cover-meta
 * fields (heroQuery, card photo queries, title/subtitle/tagline/routeLine/badge,
 * day TITLES, kickers) because their topical keywords coincidentally overlap a
 * dropped block's vocabulary and would falsely mark it "covered". Biasing toward
 * "not covered" is safe — at worst we re-include a block the user did provide.
 */
function coverageHaystack(c: any): string {
  const parts: string[] = [];
  const push = (s: unknown) => {
    if (typeof s === 'string' && s.trim()) parts.push(s);
  };
  push(c?.intro?.heading);
  push(c?.intro?.body);
  push(c?.highlights?.heading);
  (c?.highlights?.cards ?? []).forEach((x: any) => {
    push(x?.label);
    push(x?.caption); // captions are prose; x.query (photo search) is intentionally excluded
  });
  (c?.itinerary?.days ?? []).forEach((d: any) => push(d?.text)); // day TEXT, not the topical title
  (c?.route?.places ?? []).forEach((p: any) => {
    push(p?.body);
    push(p?.activities);
  });
  push(c?.route?.headline);
  push(c?.route?.closing);
  (c?.sections ?? []).forEach((s: any) => {
    push(s?.heading);
    push(s?.body);
    (s?.bullets ?? []).forEach(push);
    (s?.items ?? []).forEach((kv: any) => {
      push(kv?.k);
      push(kv?.v);
    });
    (s?.cards ?? []).forEach((x: any) => {
      push(x?.label);
      push(x?.caption);
    });
  });
  (c?.inclusions?.items ?? []).forEach((kv: any) => {
    push(kv?.k);
    push(kv?.v);
  });
  (c?.pricing?.rows ?? []).forEach((r: any) => {
    push(r?.label);
    push(r?.value);
  });
  push(c?.footer?.cta);
  push(c?.footer?.ctaSub);
  (c?.footer?.checklist ?? []).forEach(push);
  return normalizeWords(parts.join(' '));
}

/**
 * Completeness backstop. The composer sometimes drops whole labelled blocks of a
 * rich brief (stochastic), so a run can omit Learning Outcomes / Inclusions /
 * Cancellation Policy / About-Us even though they were provided. This DETERMINISTIC
 * pass detects any content block whose words are largely absent from the composed
 * output and appends it as a section — so the brochure ALWAYS reflects what the user
 * wrote, regardless of model variance. Generic: a free-text goal (no ALL-CAPS labels)
 * yields no blocks → no change. Never duplicates a block the composer already covered.
 */
export function ensureBriefCoverage(content: BrochureContent, goal: string): BrochureContent {
  const blocks = splitBriefBlocks(goal || '');
  if (!blocks.length) return content;
  const haystack = coverageHaystack(content);
  const existing = Array.isArray((content as any).sections) ? [...(content as any).sections] : [];
  const added: Record<string, unknown>[] = [];
  for (const b of blocks) {
    if (!b.body || COVERAGE_SKIP.test(b.heading.trim()) || isDirectiveHeading(b.heading)) continue;
    const toks = salientTokens(b.body);
    if (!toks.length) continue;
    const hit = toks.filter((t) => haystack.includes(t)).length;
    if (hit / toks.length >= 0.34) continue; // already represented in the output
    added.push(briefBlockToSection(b));
  }

  // Footer backstop — the composer intermittently drops the contact/CTA footer even
  // when the brief provides it, so the closing page (QR + contact lockup) appears on
  // some runs and not others. Deterministically synthesize the footer from the brief's
  // CONTACT / CALL-TO-ACTION blocks when the composed footer lacks them, so the last
  // page is CONSISTENT regardless of model variance. Only FILLS gaps — a footer the
  // composer already produced is preserved.
  const footer: Record<string, unknown> = { ...((content as any).footer || {}) };
  if (!Array.isArray(footer.contactLines) || !footer.contactLines.length) {
    const cb = blocks.find((b) => /^contact/i.test(b.heading.trim()));
    if (cb) {
      const lines = cleanBrief(cb.body)
        .split(/\n|·|\||;/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 4);
      if (lines.length) footer.contactLines = lines;
    }
  }
  if (!footer.cta) {
    const ab = blocks.find((b) => /call ?to ?action|^cta$/i.test(b.heading.trim()));
    if (ab) {
      const cta = cleanBrief(ab.body)
        .split('\n')
        .map((l) => l.trim())
        .find(Boolean);
      if (cta) footer.cta = cta.slice(0, 120);
    }
  }
  const footerPatch =
    footer.cta || (Array.isArray(footer.contactLines) && footer.contactLines.length) || footer.qrData ? footer : null;

  if (!added.length && !footerPatch) return content;
  return {
    ...content,
    ...(added.length ? { sections: [...existing, ...added] } : {}),
    ...(footerPatch ? { footer: footerPatch } : {}),
  } as BrochureContent;
}

// Internal: carry the resolved cover mode + map mode + brand kit on the content object.
declare module './types.js' {
  interface BrochureContent {
    __mode?: string;
    /** true → render the 3D country-silhouette map; default/false → the real 2D basemap. */
    __map3d?: boolean;
    /** Server-resolved, trusted brand kit (logo + optional details). Never LLM-supplied. */
    __brand?: BrandKit;
  }
}

/** Where the uploaded brand logo is placed. A fixed enum — never raw user text. */
export type LogoPlacement =
  | 'cover' // tasteful default: a small mark on the cover (+ footer if present)
  | 'cover-only' // cover mark only, no interior/footer mark
  | 'top-left' // cover masthead-left + an interior running mark, left
  | 'top-right' // cover masthead-right + an interior running mark, right
  | 'every-page' // a small running mark on every interior page
  | 'footer'; // a small mark in the cover footer lockup only

/** A page edge anchor — used for the interior running mark in the custom placer. */
export type LogoCorner =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

/**
 * Exact, user-dragged logo placement from the visual "Place logo" popup. When set
 * on a BrandKit it OVERRIDES the prompt-parsed `placement` enum entirely. Every
 * value is a server-CLAMPED number / fixed enum (validated at the API boundary,
 * see `sanitizeBrandKit`) — never raw user text — so the coordinates are safe to
 * interpolate straight into inline styles with no escaping/injection risk.
 *
 * The cover is a fixed full-bleed photo composition, so a logo placed anywhere
 * over it is collision-safe by construction (free x/y/size). The interior mark is
 * constrained to a page CORNER with a bounded size: it renders with ZERO flow
 * height (an absolute overlay on a frosted plate), so it can never push content,
 * add a page, or cause a pagination error — it just sits, legibly, in the corner.
 */
export interface LogoPlacementCustom {
  /**
   * Cover logo: normalised CENTRE position (x,y each 0..1 of the page) + width as
   * a fraction of page width. `null` = no logo on the cover.
   */
  cover: { x: number; y: number; scale: number } | null;
  /**
   * Interior running mark: which page corner + width (fraction of page width).
   * `null` = no interior mark (logo on the cover only).
   */
  interior: { corner: LogoCorner; scale: number } | null;
}

/**
 * A server-resolved, TRUSTED brand kit. Everything is OPTIONAL: with no logo the
 * brochure shows the text wordmark exactly as today; with no colours the accent
 * is inferred from the destination as today. The logo is an INERT data: URI built
 * server-side from an uploaded file — NEVER a user-supplied external URL, never on
 * BrochureContent, never through a tool-call argument.
 */
export interface BrandKit {
  /** Inline data: URI for the logo, or '' / undefined = none (text wordmark). */
  logoUrl?: string;
  /** Logo placement parsed from the user's prompt; defaults to 'cover'. */
  placement?: LogoPlacement;
  /**
   * Exact, user-dragged placement from the visual placer. When present it OVERRIDES
   * `placement` entirely (cover free-position + size, interior corner mark). All
   * values are server-clamped numbers/enums — never raw user text.
   */
  custom?: LogoPlacementCustom;
  /** Optional brand name; overrides agencyName on the cover/footer when set. */
  name?: string;
  /** Optional tagline override. */
  tagline?: string;
  /** Optional brand colours; accent overrides the destination-inferred accent. */
  colors?: { accent?: string; accentSecondary?: string };
  /** Optional contact lines; appended to the footer if the content lacks them. */
  contact?: string[];
  /** Optional Simple-Icons social slugs. */
  socials?: string[];
  /** Optional client-supplied URL to encode into the brochure QR code. Takes priority
   *  over the composer's own footer.qrData (so a pasted link always wins). */
  qrData?: string;
  /** Hint that the logo is dark and needs a light chip behind it on the dark cover. */
  onDark?: boolean;
  /** ADDITIONAL cover logos beyond the primary `logoUrl` — each an inert data: URI with
   *  its own free cover placement (centre x,y + width as 0..1 fractions). Cover-only;
   *  the primary logo still owns the interior running mark. Server-clamped numbers. */
  coverLogos?: Array<{ url: string; x: number; y: number; scale: number; onDark?: boolean }>;
  /** Interior-pages logo BAND — a horizontal row of logos (chosen from the kit) shown on
   *  every page after the cover. `band` = header (top) or bottom; all share one height
   *  (`scale`); each item sits at horizontal centre `x` (0..1). Takes precedence over the
   *  single `custom.interior` mark. Banded honours header only (full-bleed bottom clashes);
   *  editorial honours both. The engine RESERVES the band height so page text reflows clear. */
  interiorLogos?: {
    band: 'header' | 'bottom';
    scale: number;
    items: Array<{ url: string; x: number; onDark?: boolean }>;
  };
}

/** Effective interior-mark scale — the band's shared scale wins over the single mark's. */
function interiorMarkScale(c: BrochureContent): number | null {
  const b = c.__brand;
  if (b?.interiorLogos?.items?.length) return b.interiorLogos.scale;
  return b?.custom?.interior?.scale ?? null;
}

/** The interior logo BAND HTML — a full-width absolute strip of logos at their x
 *  positions, all at the shared height. Rendered in place of the single running mark
 *  when `interiorLogos` is set. `fam` picks the family class + height model; banded
 *  clamps a bottom band to the header (its full-bleed bottom can't reflow). */
function interiorLogoBandHtml(c: BrochureContent, fam: 'editorial' | 'banded'): string {
  const il = c.__brand?.interiorLogos;
  if (!il?.items?.length) return '';
  const rawCorner: LogoCorner = il.band === 'bottom' ? 'bottom-center' : 'top-center';
  const corner = fam === 'banded' ? bandedSafeCorner(rawCorner)! : rawCorner;
  const bottom = corner.startsWith('bottom');
  const h = customMarkH(il.scale, corner, fam);
  const cls = fam === 'editorial' ? 'ed-logoband' : 'logoband';
  const imgs = il.items
    .map((it) => {
      if (!it?.url) return '';
      const plate = it.onDark === false ? ' bare' : '';
      const x = round1(clampN(it.x, 0, 1) * 100);
      return `<img class="${cls}__img${plate}" src="${esc(it.url)}" alt="" style="left:${x}%;height:${round1(h)}mm">`;
    })
    .join('');
  return imgs ? `<div class="${cls} ${bottom ? 'bottom' : 'top'}">${imgs}</div>` : '';
}

/** Render every ADDITIONAL cover logo (`brand.coverLogos`) as a free overlay — same
 *  absolute-positioned box the primary custom-cover logo uses, one per entry. `cls` is
 *  the family overlay class (`freelogo` banded · `ed-freelogo` editorial). All numbers
 *  are server-clamped, so they're safe to interpolate into the inline style. */
function coverLogosHtml(brand: BrandKit | undefined, cls: string): string {
  const logos = brand?.coverLogos ?? [];
  return logos
    .map((l) => {
      if (!l?.url) return '';
      const plate = l.onDark === false ? ' bare' : '';
      const left = round1(clampN(l.x, 0, 1) * 100);
      const top = round1(clampN(l.y, 0, 1) * 100);
      const w = round1(clampN(l.scale, 0.06, 0.6) * 100);
      return `<div class="${cls}${plate}" style="left:${left}%;top:${top}%;width:${w}%"><img src="${esc(l.url)}" alt=""></div>`;
    })
    .join('');
}

/** The URL the QR code encodes: the user's Brand-Kit link wins over the composer's
 *  own qrData. Returns '' when neither is set (no QR rendered). */
function brandOrFooterQr(c: BrochureContent): string {
  const src = c.__brand?.qrData || c.footer?.qrData;
  return src ? qrUrl(src, 240) : '';
}

/**
 * Measures the real rendered height (mm) of each editorial block in headless
 * Chrome so pagination can NEVER clip. Injected by the caller (render.ts owns
 * puppeteer) to avoid an import cycle. Returns id→mm, or null on any failure
 * (host without Chromium, timeout, …) → the engine falls back to over-estimates.
 */
export type EdMeasureFn = (
  measuringHtml: string,
  ids: string[],
) => Promise<Record<string, number> | null>;

export interface BrochureRenderOptions {
  /** Use the 3D country-silhouette map instead of the default geographic 2D basemap. */
  map3d?: boolean;
  /** Headless-Chrome block measurer (editorial family). Absent → conservative estimates. */
  measure?: EdMeasureFn;
  /** Trusted brand kit (logo + optional details), resolved server-side. */
  brand?: BrandKit;
}

/**
 * Build the full HTML document from structured content + a template, fetching
 * real photos / route map / QR from the content's queries. Resilient: any asset
 * that fails simply falls back (gradient card, omitted map) — never throws.
 */
export async function buildBrochureHtml(
  content: BrochureContent,
  tpl: BrochureTemplate,
  opts?: BrochureRenderOptions,
): Promise<string> {
  content.__map3d = !!opts?.map3d;
  if (opts?.brand) content.__brand = opts.brand;
  // Brand Kit owns the agency identity → drop composer-invented agency name/website so
  // a fabricated agency can't clash with the real brand (applies to every family).
  applyBrandIdentity(content);

  if (tpl.family === 'banded') {
    return buildBandedHtml(content, tpl, opts?.measure);
  }
  // (banded reads the logo off content.__brand inside buildBandedHtml)
  if (tpl.family === 'editorial') {
    return buildEditorialHtml(content, tpl, opts?.measure);
  }

  const c = content;
  c.__mode = tpl.cover;
  const accent = normalizeAccent(c.__brand?.colors?.accent || c.palette?.accent);

  // ---- Gather + fetch assets (parallel, capped) ----
  const highlightCards = (c.highlights?.cards ?? []).slice(0, 9);
  const sectionCardSets = (c.sections ?? []).map((s) => (s.cards ?? []).slice(0, 9));
  let photoBudget = MAX_PHOTOS;
  const heroP = pick(c.heroQuery);
  photoBudget -= 1;
  const hlP = highlightCards.map((card) => (photoBudget-- > 0 ? pick(card.query) : Promise.resolve('')));
  const secP = sectionCardSets.map((set) => set.map((card) => (photoBudget-- > 0 ? pick(card.query) : Promise.resolve(''))));

  const [hero, hlUrls, secUrls] = await Promise.all([
    heroP,
    Promise.all(hlP),
    Promise.all(secP.map((arr) => Promise.all(arr))),
  ]);

  // Route map (sequential geocoding handled inside routeMapUrl).
  let map = '';
  const cities = routeCities(c); // explicit cities → places → parsed routeLine (reliability)
  if (cities.length >= 2) {
    try {
      map = await routeMapUrl(cities, { color: accent.replace('#', ''), width: 1280, height: 460 });
    } catch {
      map = '';
    }
  }
  const qr = brandOrFooterQr(c);

  // ---- Body sections (flow order) ----
  const parts: string[] = [];

  // Cover
  parts.push(`<section class="cover cv-${tpl.cover}">${coverInner(c, hero, hlUrls)}</section>`);

  // Open the flowing content wrapper
  parts.push('<main class="content">');

  // Intro band
  if (c.intro && (c.intro.heading || c.intro.body)) {
    parts.push(
      `<section class="section"><div class="band">` +
        (c.intro.kicker ? `<div class="kicker">${esc(c.intro.kicker)}</div>` : '') +
        (c.intro.heading ? `<h2>${esc(c.intro.heading)}</h2>` : '') +
        (c.intro.body ? `<p>${esc(c.intro.body)}</p>` : '') +
        `</div></section>`,
    );
  }

  // Highlights
  if (highlightCards.length) {
    parts.push(
      `<section class="section">${head(c.highlights?.kicker, c.highlights?.heading)}${gridHtml(
        highlightCards,
        hlUrls,
        c.highlights?.stat,
      )}</section>`,
    );
  }

  // Itinerary
  const days = c.itinerary?.days ?? [];
  if (days.length) {
    const li = days
      .map((d) => `<li><div class="d">${esc(d.title)}</div><div class="t">${esc(d.text)}</div></li>`)
      .join('');
    parts.push(`<section class="section">${head(c.itinerary?.kicker, c.itinerary?.heading)}<ol class="itin">${li}</ol></section>`);
  }

  // Route map
  if (map) {
    parts.push(`<section class="section">${head(c.route?.kicker || 'The Route', c.route?.heading)}<div class="map"><img src="${esc(map)}" alt="Route map"></div></section>`);
  }

  // Flexible extra sections
  (c.sections ?? []).forEach((s, idx) => {
    parts.push(`<section class="section">${renderFlexSection(s, secUrls[idx] ?? [])}</section>`);
  });

  // Inclusions
  const inclItems = c.inclusions?.items ?? [];
  if (inclItems.length) {
    parts.push(`<section class="section">${head(c.inclusions?.kicker || "What's included", c.inclusions?.heading)}${inclHtml(inclItems)}</section>`);
  }

  // Pricing
  const priceRows = c.pricing?.rows ?? [];
  if (priceRows.length) {
    const rows = priceRows
      .map(
        (r) =>
          `<tr><td class="lbl">${esc(r.label)}</td><td class="${r.emphasize ? 'amt' : ''}">${esc(r.value)}</td></tr>`,
      )
      .join('');
    parts.push(
      `<section class="section">${head(c.pricing?.kicker || 'Investment', c.pricing?.heading)}<table class="pricing"><tr><th>Item</th><th>Details</th></tr>${rows}</table>` +
        (c.pricing?.note ? `<div class="pricing-note">${esc(c.pricing.note)}</div>` : '') +
        `</section>`,
    );
  }

  // Footer / CTA
  const flowContacts = footerContactLines(c);
  const flowSocials = footerSocials(c);
  if (c.footer?.cta || flowContacts.length || flowSocials.length || qr) {
    const social = flowSocials
      .map((s) => `<img src="https://cdn.simpleicons.org/${encodeURIComponent(s.toLowerCase())}/ffffff" alt="">`)
      .join('');
    const meta = flowContacts.map((l) => esc(l)).join('<br>');
    parts.push(
      `<section class="section"><div class="footer"><div>` +
        (c.footer?.cta
          ? `<div class="cta"><span class="em">${esc(c.footer.cta)}</span>${c.footer?.ctaSub ? `<br>${esc(c.footer.ctaSub)}` : ''}</div>`
          : '') +
        (meta ? `<div class="meta">${meta}</div>` : '') +
        (social ? `<div class="soc">${social}</div>` : '') +
        `</div>` +
        (qr ? `<div class="qr"><img src="${esc(qr)}" alt="QR"></div>` : '') +
        `</div></section>`,
    );
  }

  parts.push('</main>');

  const themeVars = resolveThemeVars(tpl, accent, c.palette?.accentSecondary);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">${fontsLink(
    tpl.fonts.display,
    tpl.fonts.body,
  )}<style>${themeVars}${BASE_CSS}${tpl.css}</style></head><body>${parts.join('')}</body></html>`;
}

function renderFlexSection(s: BrochureSection, urls: string[]): string {
  const layout = s.layout ?? (s.items?.length ? 'grid' : s.cards?.length ? 'cards' : 'prose');
  const h = head(s.kicker, s.heading);
  if (layout === 'grid' && s.items?.length) return h + inclHtml(s.items);
  if ((layout === 'cards' || layout === 'gallery') && s.cards?.length) {
    return h + gridHtml(s.cards.slice(0, 9), urls);
  }
  // prose
  return (
    h +
    `<div class="prose">` +
    (s.body ? `<p>${esc(s.body)}</p>` : '') +
    (s.bullets?.length ? `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '') +
    `</div>`
  );
}

// ============================================================================
// EDITORIAL FAMILY — premium magazine-editorial engine.
//
// A DELIBERATELY DISTINCT identity from the bold full-bleed banded poster (TMC):
// where TMC shouts in edge-to-edge colour bands, this whispers like a luxury
// travel magazine (Condé Nast Traveller / Suitcase / Cereal) — a cinematic
// masthead cover, a NUMBERED section grammar ("01 — WHY THIS JOURNEY"), generous
// warm-paper margins, hairline rules, a drop-cap lede, a feature-spread for the
// highlights, big accent day-numerals, and ONE full-accent pull-quote where the
// colour really POPS. The accent is pushed hard — duotone hero veil, accent
// numerals, a saturated quote band, accent leaders — so the palette sings while
// the page stays clean. Fully adaptive: it flows over as many A4 pages as the
// content needs (Chromium paginates), so a 3-day trip and a 22-day one both read
// as the same magazine.
// ============================================================================

/** Editorial palette: warm-paper neutrals + a confidently saturated accent. */
function editorialScheme(accent: string): Record<string, string> {
  const A = normalizeAccent(accent);
  const lum = relLum(A);
  // Push the accent so it POPS on warm paper: a pale accent gets deepened for
  // type/leaders; a very dark one gets a brighter sibling for the quote band.
  const accentInk = lum > 0.5 ? darken(A, 0.34) : A; // legible accent text on paper
  const quote = lum < 0.2 ? lighten(A, 0.12) : A; // full-bleed pull-quote fill
  return {
    '--accent': A,
    '--accent-ink': accentInk,
    // Accent as TEXT on the dark CTA/ink band — lightened until legible (a dark accent
    // like deep indigo would otherwise vanish into the near-black band).
    '--accent-on-dark': legibleOn(A, '#1B1A17', 4.2),
    '--accent-deep': darken(A, 0.34),
    '--accent-quote': quote,
    '--on-accent': contrastInk(quote),
    '--paper': '#FBF7EF', // warm editorial cream
    '--paper-2': '#F4ECDF', // slightly deeper panel cream
    '--ink': '#1B1A17', // warm near-black
    '--ink-soft': '#54514A', // body grey-brown
    '--line': '#E2D9C8', // hairline on cream
    '--line-ink': '#CFC4AF',
    '--cover-bg': '#14110D',
    '--accent-wash': mix('#FBF7EF', A, 0.1),
    '--accent-tint': mix('#FBF7EF', A, 0.22),
  } as Record<string, string>;
}

function resolveEditorialVars(tpl: BrochureTemplate, accent: string): string {
  const scheme = editorialScheme(accent);
  const overrides = tpl.theme(accent) || {};
  const merged: Record<string, string> = {
    ...scheme,
    '--display': `'${tpl.fonts.display}', 'Playfair Display', Georgia, serif`,
    '--body': `'${tpl.fonts.body}', system-ui, -apple-system, Helvetica, Arial, sans-serif`,
    ...overrides,
  };
  if (overrides['--accent'] && !overrides['--on-accent']) merged['--on-accent'] = contrastInk(overrides['--accent']);
  return `:root{${Object.entries(merged)
    .map(([k, v]) => `${k}:${v}`)
    .join(';')}}`;
}

const EDITORIAL_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
@page{size:A4;margin:0}
html,body{background:var(--paper)}
body{font-family:var(--body);color:var(--ink);font-size:10.4pt;line-height:1.62;-webkit-print-color-adjust:exact;print-color-adjust:exact;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
h1,h2,h3{font-family:var(--display);font-weight:700;line-height:1.04;letter-spacing:-.005em}
img{display:block;max-width:100%}
em,i{font-style:italic}

/* Composed A4 pages: each is a fixed-height flex COLUMN with an inner margin, so
   the engine controls every page bottom (no Chromium-stranded whitespace). The
   page's elastic member (.ed-grow) stretches to fill, and a closing motif can be
   pinned to the bottom — the editorial analogue of the banded family's elastic
   last band. */
.ed-page{position:relative;width:210mm;height:297mm;overflow:hidden;page-break-after:always;display:flex;flex-direction:column;padding:19mm 20mm 16mm;background:var(--paper)}
.ed-page:last-child{page-break-after:auto}
/* Escape hatch for the rare single block taller than a page: grow instead of
   clip, keeping the page margins on an inner pad (a spill page won't inherit
   the outer padding). Only used when a measured block exceeds the usable height. */
.ed-page--flow{height:auto;min-height:297mm;overflow:visible;padding:0}
.ed-page--flow > .ed-flowpad{display:flex;flex-direction:column;padding:19mm 20mm 16mm}
/* Content sections never SHRINK (flex-shrink:0) — so if a page is ever slightly
   over-packed, the trailing decorative fill photo absorbs/clips it, NOT the body
   text (a day row, a paragraph). Text is never clipped. The .ed-fill* members keep
   flex:1 1 auto, so they remain the elastic/absorbing element. */
.ed-sec{margin:0 0 13mm;flex:0 0 auto}
.ed-sec:last-child{margin-bottom:0}
.ed-grow{flex:1 1 auto;min-height:0}
.ed-spacer{flex:1 1 auto;min-height:0}
/* Elastic colophon that absorbs residual slack on an ordinary content page so it
   never reads as a stranded bottom void: a centred rule (always) + the agency
   wordmark when there's real room. Collapses to nothing when the page is full. */
.ed-fill{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:4mm;overflow:hidden}
.ed-fill__rule{width:24mm;border-top:1.2px solid var(--accent-ink);opacity:.55}
.ed-fill__mk{font:700 11pt/1.15 var(--display);letter-spacing:.06em;text-transform:uppercase;color:var(--ink);opacity:.62}
.ed-fill--photo{flex:1 1 auto;min-height:40mm;position:relative;border-radius:3px;overflow:hidden;background:var(--paper-2)}
.ed-fill--photo img{width:100%;height:100%;object-fit:cover;display:block}
.ed-fill--photo .cap{position:absolute;left:0;bottom:0;background:var(--accent);color:var(--on-accent);font:700 8pt/1 var(--body);letter-spacing:.16em;text-transform:uppercase;padding:7px 14px}
/* Interior running brand mark (every-page / top-left / top-right). Absolutely
   positioned → ZERO flow height (never affects the packer), pinned to the content
   padding edge (≥20mm) and 7mm from the top so it clears the section kicker (top
   ~19mm) by ~7mm and shares no x-range with it. */
.ed-runmark{position:absolute;top:7mm;z-index:5;display:inline-flex;align-items:center;pointer-events:none;padding:1.2mm 1.8mm;background:rgba(255,255,255,.94);border-radius:3px;box-shadow:0 1px 8px rgba(0,0,0,.16)}
.ed-runmark.right{right:20mm;justify-content:flex-end}
.ed-runmark.left{left:20mm;justify-content:flex-start}
.ed-runmark.center{left:50%;transform:translateX(-50%);justify-content:center}
.ed-runmark.bottom{top:auto;bottom:9mm}
.ed-runmark.bare{background:transparent;box-shadow:none;opacity:.92}
.ed-runmark img{height:8.5mm;width:auto;max-width:50mm;object-fit:contain}
/* CUSTOM-sized editorial mark: HEIGHT set inline (corner-safe), width auto + capped. */
.ed-runmark.custom img{width:auto;max-width:58mm}
/* Interior logo BAND — a full-width absolute strip; each logo is absolutely positioned
   at its centre x (translateX -50%), all at the inline-set shared height. The packer
   reserves the band height so page text reflows clear of it (top OR bottom). */
.ed-logoband{position:absolute;left:0;right:0;z-index:6;height:0;pointer-events:none}
.ed-logoband.top{top:9mm}
.ed-logoband.bottom{bottom:8mm}
.ed-logoband__img{position:absolute;top:0;transform:translateX(-50%);width:auto;max-width:46mm;object-fit:contain}
.ed-logoband.bottom .ed-logoband__img{top:auto;bottom:0}
.ed-logoband__img.bare{filter:drop-shadow(0 2px 9px rgba(0,0,0,.42))}
/* Itinerary: the day grid packs TIGHT at the top (a short trip must not spread its
   rows across the whole page); leftover height is absorbed by a destination photo via
   the ordinary-page fill, exactly like every other content page. */
.ed-itin{display:flex;flex-direction:column;min-height:0}
.ed-days.fill{align-content:start}

/* ---- numbered section header grammar ---- */
.ed-kick{display:flex;align-items:center;gap:9px;margin-bottom:7px}
.ed-kick .no{font-family:var(--display);font-style:italic;font-weight:700;font-size:15pt;color:var(--accent-ink);line-height:1}
.ed-kick .lab{font-size:8pt;letter-spacing:.34em;text-transform:uppercase;font-weight:700;color:var(--ink);opacity:.62}
.ed-kick .ln{flex:1;height:1px;background:var(--line-ink)}
.ed-h{font-size:25pt;line-height:1.06;margin:0 0 4mm;max-width:150mm}
.ed-h .amp{color:var(--accent-ink);font-style:italic}

/* ---- COVER (full-bleed masthead) ---- */
.ed-cover{position:relative;width:210mm;height:297mm;overflow:hidden;page-break-after:always;color:#fff;background:var(--cover-bg)}
.ed-cover .hero{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
/* duotone-ish accent veil so the cover photo carries the brand colour */
.ed-cover .veil{position:absolute;inset:0;background:
  linear-gradient(180deg,rgba(10,8,6,.46),rgba(10,8,6,.05) 32%,rgba(10,8,6,.20) 60%,rgba(10,8,6,.88)),
  linear-gradient(125deg,color-mix(in srgb,var(--accent) 42%,transparent),transparent 58%)}
.ed-cover .frame{position:absolute;inset:9mm;border:1px solid rgba(255,255,255,.42);pointer-events:none;z-index:3}
.ed-cover .frame:after{content:'';position:absolute;inset:2.4mm;border:1px solid rgba(255,255,255,.18)}
.ed-cover .masthead{position:absolute;top:16mm;left:0;right:0;display:flex;justify-content:space-between;align-items:center;padding:0 16mm;z-index:4;font-size:8.5pt;letter-spacing:.3em;text-transform:uppercase;font-weight:600;opacity:.95}
/* ---- BRAND LOGO (uploaded; placed per brand.placement) ----
   A frosted plate is the DEFAULT backing (the engine can't know the uploaded
   logo's own luminance — a light/thin logo must never vanish on the photo cover
   or a white interior page). The .bare class opts out only when the brand flags a
   light background (onDark === false). Mirrors the banded family. */
.ed-cover .ed-logo{background:rgba(255,255,255,.94);border-radius:3px;padding:2.5mm 3.5mm;box-shadow:0 2px 12px rgba(0,0,0,.22)}
.ed-cover .ed-logo.bare{background:transparent;box-shadow:none}
.ed-cover .ed-logo img{display:block;width:auto;height:auto;object-fit:contain}
.ed-cover .ed-logo.mh img{max-height:12mm;max-width:54mm}
.ed-cover .ed-logo.mh.bare img{filter:drop-shadow(0 1px 6px rgba(0,0,0,.45))}
.ed-cover .ed-logo.foot{display:inline-block;margin-bottom:3mm}
.ed-cover .ed-logo.foot img{max-height:16mm;max-width:66mm}
.ed-cover .ed-logo.foot.bare img{filter:drop-shadow(0 1px 8px rgba(0,0,0,.5))}
/* CUSTOM free cover logo (visual placer): centred on the dragged point, width inline. */
.ed-cover .ed-freelogo{position:absolute;transform:translate(-50%,-50%);z-index:6;display:flex;justify-content:center;background:rgba(255,255,255,.94);border-radius:3px;padding:2.5mm 3.5mm;box-shadow:0 2px 12px rgba(0,0,0,.22)}
.ed-cover .ed-freelogo.bare{background:transparent;box-shadow:none}
.ed-cover .ed-freelogo img{display:block;width:100%;height:auto;object-fit:contain}
.ed-cover .ed-freelogo.bare img{filter:drop-shadow(0 2px 12px rgba(0,0,0,.5))}
.ed-cover .issue{position:absolute;top:50%;right:13mm;transform:translateY(-50%) rotate(90deg);transform-origin:right center;font-size:8pt;letter-spacing:.42em;text-transform:uppercase;opacity:.8;z-index:4}
.ed-cover .lockup{position:absolute;left:16mm;right:16mm;bottom:30mm;z-index:4}
.ed-cover .pre{font-size:9pt;letter-spacing:.42em;text-transform:uppercase;opacity:.92;margin-bottom:10px;font-weight:600}
.ed-cover .pre .pip{display:inline-block;width:16px;height:2px;background:var(--accent);vertical-align:middle;margin-right:10px}
.ed-cover h1{font-size:64pt;line-height:.96;margin:0;text-shadow:0 2px 40px rgba(0,0,0,.4);max-width:175mm}
.ed-cover h1 .it{font-style:italic;font-weight:400}
.ed-cover .rule{width:42mm;height:3px;background:var(--accent);margin:11mm 0 7px;border-radius:2px}
.ed-cover .sub{font-size:13pt;font-weight:300;letter-spacing:.02em;opacity:.96;font-family:var(--body)}
.ed-cover .route{font-size:9pt;letter-spacing:.26em;text-transform:uppercase;margin-top:9px;opacity:.9;font-weight:600}
.ed-cover .foot{position:absolute;left:16mm;right:16mm;bottom:14mm;display:flex;justify-content:space-between;align-items:flex-end;z-index:4}
.ed-cover .agency{font-size:9.5pt;line-height:1.5;letter-spacing:.02em}
.ed-cover .agency b{font-weight:700;font-size:11pt;letter-spacing:.06em}
.ed-cover .badge{border:1px solid var(--accent);background:color-mix(in srgb,var(--accent) 88%,#000 0%);color:var(--on-accent);border-radius:999px;padding:8px 16px;font-size:8pt;font-weight:700;letter-spacing:.16em;text-transform:uppercase;white-space:nowrap}

/* ---- INTRO (drop-cap editorial lede) ---- */
.ed-lede{position:relative;padding-left:9mm}
.ed-lede:before{content:'';position:absolute;left:0;top:2px;bottom:2px;width:2px;background:var(--accent)}
.ed-lede p{font-size:13pt;line-height:1.66;color:var(--ink);max-width:158mm;font-weight:300}
.ed-lede p .dc{float:left;font-family:var(--display);font-weight:700;font-size:46pt;line-height:.82;padding:4px 10px 0 0;color:var(--accent-ink)}

/* ---- HIGHLIGHTS (feature spread: lead photo + caption rail) ---- */
.ed-spread{display:grid;grid-template-columns:1.55fr 1fr;gap:7mm;align-items:stretch}
.ed-lead{position:relative;border-radius:3px;overflow:hidden;min-height:118mm;background:var(--paper-2)}
.ed-lead img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.ed-lead .tag{position:absolute;left:0;bottom:0;background:var(--accent);color:var(--on-accent);font-size:8pt;letter-spacing:.2em;text-transform:uppercase;font-weight:700;padding:7px 14px}
.ed-rail{display:flex;flex-direction:column;gap:5.5mm}
.ed-rail .it{display:grid;grid-template-columns:auto 1fr;gap:11px;align-items:start;padding-bottom:5.5mm;border-bottom:1px solid var(--line)}
.ed-rail .it:last-child{border-bottom:0;padding-bottom:0}
.ed-rail .no{font-family:var(--display);font-style:italic;font-weight:700;font-size:20pt;color:var(--accent-ink);line-height:.9}
.ed-rail .ttl{font-family:var(--display);font-weight:700;font-size:13.5pt;line-height:1.1}
.ed-rail .cap{font-size:9.5pt;color:var(--ink-soft);line-height:1.45;margin-top:2px}
.ed-rail .statcard{background:var(--accent);color:var(--on-accent);border-radius:3px;padding:6mm;text-align:center;margin-top:auto}
.ed-rail .statcard .big{font-family:var(--display);font-weight:700;font-size:38pt;line-height:.9}
.ed-rail .statcard .lab{font-size:8pt;letter-spacing:.2em;text-transform:uppercase;margin-top:4px;opacity:.92}

/* ---- PULL-QUOTE (the colour POPS) ---- */
.ed-quote{background:var(--accent-quote);color:var(--on-accent);border-radius:4px;padding:16mm 18mm;text-align:center;position:relative;overflow:hidden}
.ed-quote:before{content:'\\201C';position:absolute;top:-14mm;left:8mm;font-family:var(--display);font-size:150pt;opacity:.16;line-height:1}
.ed-quote q{quotes:none}
.ed-quote .big{font-family:var(--display);font-weight:700;font-style:italic;font-size:27pt;line-height:1.18;display:block;max-width:150mm;margin:0 auto;position:relative}
.ed-quote .by{font-size:8.5pt;letter-spacing:.26em;text-transform:uppercase;margin-top:8mm;opacity:.85;font-weight:600}

/* ---- ITINERARY (big accent day-numerals, two-column rhythm) ---- */
.ed-days{display:grid;grid-template-columns:1fr 1fr;gap:7mm 11mm}
.ed-day{display:grid;grid-template-columns:auto 1fr;gap:12px;break-inside:avoid;border-top:2px solid var(--ink);padding-top:8px}
.ed-day .n{font-family:var(--display);font-weight:700;font-size:24pt;color:var(--accent-ink);line-height:.86;min-width:13mm}
.ed-day .ttl{font-family:var(--display);font-weight:700;font-size:12.5pt;line-height:1.12}
.ed-day .tx{font-size:9.3pt;color:var(--ink-soft);line-height:1.5;margin-top:3px}

/* ---- ROUTE MAP (editorial framed plate) ---- */
.ed-map{border:1px solid var(--line-ink);border-radius:3px;overflow:hidden;background:var(--paper-2)}
.ed-map img{width:100%;display:block}
/* 3D silhouette plate — a taller, near-square window so the country reads at proper scale */
.ed-map--3d{aspect-ratio:680/520;background:var(--paper-2)}
.ed-map--3d svg{width:100%;height:100%;display:block}
.ed-mapcap{display:flex;align-items:center;gap:10px;margin-top:9px;font-size:8.5pt;letter-spacing:.2em;text-transform:uppercase;color:var(--ink-soft);font-weight:600}
.ed-mapcap .pip{width:18px;height:2px;background:var(--accent)}
.ed-route-words{font-family:var(--display);font-style:italic;font-size:14pt;color:var(--accent-ink);margin-bottom:5mm}

/* ---- INCLUSIONS (editorial "contents" list with accent leaders) ---- */
.ed-incl{display:grid;grid-template-columns:1fr 1fr;gap:6mm 12mm}
.ed-incl .row{break-inside:avoid}
.ed-incl .k{display:flex;align-items:baseline;gap:8px;font-family:var(--display);font-weight:700;font-size:12pt;color:var(--ink)}
.ed-incl .k:before{content:'';width:7px;height:7px;border-radius:50%;background:var(--accent);flex:0 0 auto;transform:translateY(-1px)}
.ed-incl .v{font-size:9.4pt;color:var(--ink-soft);line-height:1.5;margin:3px 0 0 15px}

/* ---- PRICING (clean editorial fee list) ---- */
.ed-price{border-top:2px solid var(--ink)}
.ed-price .r{display:flex;justify-content:space-between;align-items:baseline;gap:14px;padding:9px 0;border-bottom:1px solid var(--line)}
.ed-price .r.hero{padding:12px 0}
.ed-price .lbl{font-size:10pt;color:var(--ink);letter-spacing:.01em}
.ed-price .r.hero .lbl{font-family:var(--display);font-weight:700;font-size:13pt}
.ed-price .val{font-family:var(--display);font-weight:700;font-size:12pt;text-align:right;white-space:nowrap}
.ed-price .r.hero .val{color:var(--accent-ink);font-size:17pt}
.ed-price-note{font-size:8.5pt;color:var(--ink-soft);margin-top:9px;font-style:italic}

/* ---- PROSE flex section ---- */
.ed-prose p{font-size:10.5pt;line-height:1.66;color:var(--ink-soft);max-width:160mm}
.ed-prose ul{margin:8px 0 0;list-style:none}
.ed-prose li{position:relative;padding:0 0 6px 16px;font-size:10pt;color:var(--ink-soft)}
.ed-prose li:before{content:'';position:absolute;left:0;top:8px;width:6px;height:6px;border-radius:50%;background:var(--accent)}

/* ---- FAST FACTS (adaptive page-filler: a "good to know" band) ---- */
.ed-facts{border-top:1px solid var(--line-ink);border-bottom:1px solid var(--line-ink);padding:7mm 0;display:grid;grid-template-columns:repeat(4,1fr);gap:6mm}
.ed-facts.cols-3{grid-template-columns:repeat(3,1fr)}
.ed-facts.cols-2{grid-template-columns:repeat(2,1fr)}
.ed-fact{text-align:left}
.ed-fact .ft-k{font-size:7.5pt;letter-spacing:.22em;text-transform:uppercase;color:var(--ink-soft);font-weight:700;margin-bottom:5px}
.ed-fact .ft-v{font-family:var(--display);font-weight:700;font-size:15pt;line-height:1.08;color:var(--ink)}
.ed-fact .ft-v .u{color:var(--accent-ink)}

/* ---- CLOSING SEAL (adaptive end-motif: compass + route arc) ---- */
.ed-seal{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:5mm;padding:6mm 0}
.ed-seal svg{display:block}
.ed-seal .ttl{font-family:var(--display);font-style:italic;font-weight:700;font-size:18pt;color:var(--accent-ink)}
.ed-seal .sub{font-size:8.5pt;letter-spacing:.28em;text-transform:uppercase;color:var(--ink-soft);font-weight:600}

/* ---- CTA / FOOTER (accent block) ---- */
.ed-cta{background:var(--ink);color:#fff;border-radius:4px;padding:13mm 14mm;display:flex;justify-content:space-between;align-items:center;gap:14mm}
.ed-cta .big{font-family:var(--display);font-weight:700;font-size:21pt;line-height:1.16}
.ed-cta .big .em{color:var(--accent-on-dark);font-style:italic}
.ed-cta .chk{list-style:none;margin:8px 0 0}
.ed-cta .chk li{position:relative;padding:0 0 4px 18px;font-size:9pt;opacity:.92}
.ed-cta .chk li:before{content:'';position:absolute;left:0;top:6px;width:8px;height:8px;border-radius:50%;background:var(--accent-on-dark)}
.ed-cta .meta{font-size:9pt;line-height:1.7;margin-top:9px;opacity:.85}
.ed-cta .soc{display:flex;gap:10px;margin-top:9px}
.ed-cta .soc img{width:17px;height:17px}
.ed-cta .qr{background:#fff;padding:7px;border-radius:6px;flex:0 0 auto}
.ed-cta .qr img{width:30mm;height:30mm;display:block}
`;

/** Editorial cover — cinematic masthead, lower-left lockup, double keyline frame.
 *  An uploaded brand logo is placed per `brand.placement`: into the masthead for
 *  'top-left'/'top-right', else a small mark beside the foot agency line. With no
 *  logo the text wordmark shows exactly as before. */
function editorialCover(c: BrochureContent, hero: string): string {
  const brand = c.__brand;
  const logo = brand?.logoUrl || '';
  const placement = brand?.placement || 'cover';
  // Frosted plate by default so a light logo never vanishes; `.bare` only when the
  // brand explicitly flags a light background. Mirrors the banded family.
  const plate = brand?.onDark === false ? ' bare' : '';
  const heroImg = hero ? `<img class="hero" src="${esc(hero)}" alt="">` : '';
  const brandName = brand?.name || c.agencyName || '';
  const customActive = !!brand?.custom; // when set, the prompt enum is fully ignored
  const fc = brand?.custom?.cover || null; // free cover placement (may be null)

  // Masthead: in AUTO mode the uploaded logo owns a top corner (left for top-left/
  // cover/cover-only, right for top-right). In CUSTOM mode the masthead keeps only
  // its TEXT marks — the logo is a free overlay positioned by the user (below).
  const mhLogo = logo && !customActive ? `<span class="ed-logo mh${plate}"><img src="${esc(logo)}" alt=""></span>` : '';
  const logoRight = placement === 'top-right';
  const lText = esc(c.topLeft || brandName || '');
  const rText = esc(c.topRight || c.year || '');
  // When any cover logo overlaps the masthead, the agency/edition text yields
  // beside it (wraps to the side gap, or drops if there's no room) — logo wins.
  const ko = combinedMastheadKeepout(brand, 16);
  let leftSlot: string;
  let rightSlot: string;
  if (mhLogo) {
    leftSlot = !logoRight ? mhLogo : `<span>${lText}</span>`;
    rightSlot = logoRight ? mhLogo : `<span>${rText}</span>`;
  } else {
    leftSlot = `<span${ko ? mhSlotStyle(ko.left) : ''}>${!ko || ko.left >= MH_MIN ? lText : ''}</span>`;
    rightSlot = `<span${ko ? mhSlotStyle(ko.right) : ''}>${!ko || ko.right >= MH_MIN ? rText : ''}</span>`;
  }
  const masthead = `<div class="masthead">${leftSlot}${rightSlot}</div>`;
  // Free overlay for a CUSTOM cover placement (clamped numbers → safe inline style).
  const freeLogo =
    fc && logo
      ? `<div class="ed-freelogo${plate}" style="left:${round1(clampN(fc.x, 0, 1) * 100)}%;top:${round1(
          clampN(fc.y, 0, 1) * 100,
        )}%;width:${round1(clampN(fc.scale, 0.06, 0.6) * 100)}%"><img src="${esc(logo)}" alt=""></div>`
      : '';

  const issue = c.year ? `<div class="issue">Edition · ${esc(c.year)}</div>` : '';
  // Italicise the final word of the title for a magazine masthead feel.
  const t = String(c.title || '').trim();
  const sp = t.lastIndexOf(' ');
  const titleHtml =
    sp > 0 ? `${esc(t.slice(0, sp))} <span class="it">${esc(t.slice(sp + 1))}</span>` : esc(t);
  // If a cover logo overlaps the lockup or foot, add a subtle shield so the text
  // stays legible over the photo.
  const lockupShield = logoOverlapsRegion(brand, { x: 16, y: 210, w: 178, h: 80 }) ? 'background:rgba(0,0,0,0.42);padding:3mm 4mm;border-radius:2mm;' : '';
  const lockup =
    `<div class="lockup"${lockupShield ? ` style="${lockupShield}"` : ''}>` +
    (c.preTitle ? `<div class="pre"><span class="pip"></span>${esc(c.preTitle)}</div>` : '') +
    `<h1>${titleHtml}</h1>` +
    `<div class="rule"></div>` +
    (c.subtitle ? `<div class="sub">${esc(c.subtitle)}</div>` : '') +
    (c.routeLine ? `<div class="route">${esc(c.routeLine)}</div>` : '') +
    `</div>`;

  const agencyText = brandName ? `<b>${esc(brandName)}</b><br>` : '';
  const footShield = logoOverlapsRegion(brand, { x: 16, y: 270, w: 178, h: 15 }) ? 'background:rgba(0,0,0,0.42);padding:2mm 3mm;border-radius:2mm;' : '';
  const foot =
    `<div class="foot"${footShield ? ` style="${footShield}"` : ''}>` +
    `<div class="agency">${agencyText}${esc(c.agencyLine || '')}</div>` +
    (c.badge ? `<div class="badge">${esc(c.badge)}</div>` : '') +
    `</div>`;
  return `<section class="ed-cover">${heroImg}<div class="veil"></div><div class="frame"></div>${masthead}${freeLogo}${coverLogosHtml(brand, 'ed-freelogo')}${issue}${lockup}${foot}</section>`;
}

/**
 * Editorial interior running mark. Corner + side come from `runMarkCorner` (the same
 * source of truth banded uses), so the two families behave identically and a custom
 * placer corner (incl. the two BOTTOM corners) is honoured. Absolute + zero flow
 * height → never affects the packer, never adds a page. Returns '' when no mark.
 */
function editorialRunMark(c: BrochureContent): string {
  const brand = c.__brand;
  // Multi-logo interior BAND wins over the single mark when present.
  if (brand?.interiorLogos?.items?.length) return interiorLogoBandHtml(c, 'editorial');
  const logo = brand?.logoUrl;
  const corner = runMarkCorner(c);
  if (!logo || !corner) return '';
  const side = markSide(corner);
  const vert = corner.startsWith('bottom') ? ' bottom' : '';
  const plate = brand?.onDark === false ? ' bare' : '';
  const cust = brand?.custom?.interior;
  if (cust) {
    // Height-driven + corner-safe (see customMarkH) — clears the editorial section
    // kicker on top corners, never overprints content.
    return `<div class="ed-runmark ${side}${vert} custom${plate}"><img src="${esc(logo)}" alt="" style="height:${customMarkH(cust.scale, corner, 'editorial')}mm"></div>`;
  }
  return `<div class="ed-runmark ${side}${vert}${plate}"><img src="${esc(logo)}" alt=""></div>`;
}

/**
 * Adaptive "fast facts" — a small at-a-glance band derived ENTIRELY from the
 * content so it adapts to ANY destination/trip: trip length (from days or the
 * subtitle), number of stops (route cities/places), group size (parsed from the
 * badge), and a "from" price (the emphasised pricing row). Anything we can't
 * derive is simply omitted, so a thin prompt yields fewer facts (and the band
 * re-columns) rather than a fake one. Returns '' if fewer than 2 real facts.
 */
function editorialFacts(c: BrochureContent): string {
  const facts: { k: string; v: string; u?: string }[] = [];

  // Trip length: prefer explicit days; else pull a leading number from subtitle.
  const dayN = c.itinerary?.days?.length;
  const subM = /(\d+)\s*(?:day|night)/i.exec(c.subtitle || '');
  if (dayN && dayN > 0) facts.push({ k: 'Duration', v: String(dayN), u: dayN === 1 ? 'Day' : 'Days' });
  else if (subM) facts.push({ k: 'Duration', v: subM[1]!, u: /night/i.test(subM[0]) ? 'Nights' : 'Days' });

  // Stops: route places/cities.
  const stops = c.route?.places?.length || c.route?.cities?.length || 0;
  if (stops >= 2) facts.push({ k: 'Stops', v: String(stops), u: stops === 1 ? 'Place' : 'Places' });

  // Group size: parse a number out of the badge ("Limited to 16 Travellers").
  const grpM = /(\d+)/.exec(c.badge || '');
  if (grpM) facts.push({ k: 'Group', v: `${grpM[1]}`, u: 'Max' });

  // From-price: the emphasised pricing row's first number-with-currency token.
  const heroRow = (c.pricing?.rows || []).find((r) => r.emphasize) || c.pricing?.rows?.[0];
  const priceM = heroRow ? /([₹$€£]\s?[\d,]+(?:\.\d+)?)/.exec(heroRow.value) : null;
  if (priceM) facts.push({ k: 'From', v: priceM[1]!.replace(/\s/g, ''), u: 'pp' });

  // Stays count: inclusions key that looks like accommodation, with a number.
  if (facts.length < 4) {
    const stay = (c.inclusions?.items || []).find((it) => /stay|hotel|night|accommodat|riad|houseboat|lodge/i.test(it.k + ' ' + it.v));
    const nightM = stay ? /(\d+)\s*night/i.exec(stay.v) : null;
    if (nightM) facts.push({ k: 'Nights', v: nightM[1]!, u: 'Stay' });
  }

  if (facts.length < 2) return '';
  const cols = facts.length >= 4 ? 4 : facts.length;
  const cells = facts
    .slice(0, 4)
    .map(
      (f) =>
        `<div class="ed-fact"><div class="ft-k">${esc(f.k)}</div>` +
        `<div class="ft-v">${esc(f.v)}${f.u ? ` <span class="u">${esc(f.u)}</span>` : ''}</div></div>`,
    )
    .join('');
  return `<div class="ed-facts cols-${cols}">${cells}</div>`;
}

/** A small adaptive end-of-brochure motif: an accent compass rose + route words. */
function editorialSeal(c: BrochureContent): string {
  const a = 'var(--accent)';
  const ai = 'var(--accent-ink)';
  // A simple 8-point compass rose drawn in the accent — destination-agnostic.
  const svg =
    `<svg width="58" height="58" viewBox="0 0 100 100" fill="none">` +
    `<circle cx="50" cy="50" r="46" stroke="${ai}" stroke-width="1.4" opacity=".5"/>` +
    `<circle cx="50" cy="50" r="33" stroke="${ai}" stroke-width="1" opacity=".3"/>` +
    `<polygon points="50,6 57,50 50,50" fill="${a}"/><polygon points="50,6 43,50 50,50" fill="${ai}"/>` +
    `<polygon points="50,94 57,50 50,50" fill="${ai}" opacity=".55"/><polygon points="50,94 43,50 50,50" fill="${a}" opacity=".55"/>` +
    `<polygon points="6,50 50,57 50,50" fill="${ai}" opacity=".4"/><polygon points="94,50 50,57 50,50" fill="${ai}" opacity=".4"/>` +
    `<circle cx="50" cy="50" r="4" fill="${a}"/></svg>`;
  const words =
    c.routeLine ||
    (c.route?.cities && c.route.cities.length
      ? `${c.route.cities[0]!.split(',')[0]} — ${c.route.cities[c.route.cities.length - 1]!.split(',')[0]}`
      : c.tagline || '');
  return (
    `<div class="ed-seal">${svg}` +
    (words ? `<div class="ttl">${esc(words)}</div>` : '') +
    (c.agencyName ? `<div class="sub">${esc(c.agencyName)}</div>` : '') +
    `</div>`
  );
}

/**
 * VARIED fill-photo captions. The tagline is the page's pull-quote — repeating it on
 * every filler photo (as before) reads as a bug. Instead, cycle through real content:
 * route stops (name · subtitle), highlight labels, the route headline / subtitle. The
 * tagline + the brochure title are deliberately EXCLUDED so a caption never echoes the
 * big quote. Falls back to the agency wordmark only if there's nothing else.
 */
function makeCaptionPicker(c: BrochureContent): () => string {
  const taken = (c.__brand?.tagline || c.tagline || '').trim().toLowerCase();
  const pool: string[] = [];
  const add = (s?: string) => {
    const t = (s || '').trim();
    if (t && t.toLowerCase() !== taken && !pool.some((p) => p.toLowerCase() === t.toLowerCase())) pool.push(t);
  };
  (c.route?.places ?? []).forEach((p) => add(p?.subtitle ? `${p.name} · ${p.subtitle}` : p?.name));
  (c.highlights?.cards ?? []).forEach((h) => add(h?.label));
  add(c.route?.headline);
  add(c.route?.heading);
  add(c.subtitle);
  const fallback = (c.__brand?.name || c.agencyName || '').trim();
  let i = 0;
  return () => {
    if (!pool.length) return esc(fallback);
    const v = pool[i % pool.length]!;
    i++;
    return esc(v);
  };
}

/** Elastic colophon for an ordinary editorial page's leftover height: a centred
 *  rule (any real slack) + the agency wordmark (with room) so a short page reads
 *  as deliberate, never stranded. Collapses to nothing on a full page. */
function editorialFill(c: BrochureContent, takeFill: () => string, takeCaption: () => string, room: number): string {
  if (room <= 12) return ''; // negligible — reads as clean bottom margin
  // A generous gap is best USED: close the page with an inset destination photo
  // (matches the editorial feature-spread aesthetic) — a UNIQUE one via takeFill(),
  // captioned with a VARIED place/highlight (never the repeated tagline).
  if (room > 46) {
    const img = takeFill();
    if (img) {
      const cap = takeCaption();
      return (
        `<div class="ed-fill--photo"><img src="${esc(img)}" alt="">` +
        (cap ? `<span class="cap">${cap}</span>` : '') +
        `</div>`
      );
    }
  }
  const agency = esc(c.__brand?.name || c.agencyName || '');
  const mark = room > 30 && agency ? `<div class="ed-fill__mk">${agency}</div>` : '';
  return `<div class="ed-fill"><div class="ed-fill__rule"></div>${mark}</div>`;
}

/** Numbered editorial section header. */
function edHead(no: number, kicker?: string, heading?: string): string {
  const k =
    `<div class="ed-kick"><span class="no">${String(no).padStart(2, '0')}</span>` +
    `<span class="lab">${esc(kicker || '')}</span><span class="ln"></span></div>`;
  // Italicise an " & " / "and" join in the heading for editorial flavour.
  const h = heading
    ? `<h2 class="ed-h">${esc(heading).replace(/ &amp; /g, ' <span class="amp">&amp;</span> ')}</h2>`
    : '';
  return k + h;
}

// ---- Editorial pagination model ----
// Each section is an EdBlock with a stable id + a CONSERVATIVE over-estimate
// height (hEst, mm). When a measurer is available, real Chrome heights replace
// the estimates so pagination can NEVER clip; when it isn't, the over-estimates
// bias toward MORE pages (spill > clip). The packer adds the real .ed-sec gap.
interface EdBlock {
  id: string;
  html: string;
  hEst: number;
  grow?: boolean; // itinerary chunk — its .ed-days.fill stretches to fill the page
  elastic?: boolean; // CTA — pinned to the page bottom by a leading spacer
}

const ED_USABLE = 262; // 297 - 19(top) - 16(bottom) page padding (mm)
const ED_SEC_GAP = 13; // .ed-sec margin-bottom (mm) — real chrome BETWEEN stacked blocks
const ED_SAFETY = 2; // mm cushion vs sub-pixel rounding; bias toward a page break
const ED_HEAD = 20; // numbered section header (kicker + h2) estimate (mm)
const ED_LINE13 = 7.0; // ~mm per wrapped line @ 13pt
const ED_LINE10 = 5.6; // ~mm per wrapped line @ 10.5pt
const ED_ITIN_CHUNK = 8; // max itinerary days per page-chunk

/** Trust a measured height, else fall back to the conservative estimate. */
function sanitizeMeasured(mm: number | undefined, est: number): number {
  if (mm == null || !Number.isFinite(mm) || mm <= 0) return est; // absent/bad → estimate
  if (mm > ED_USABLE * 1.05) return est; // implausibly tall (>1 page) → estimate
  return mm;
}

/** Blank every remote <img src> so the measuring pass hits no network (fixed-geometry CSS holds the box). */
function stripImgSrc(html: string): string {
  return html.replace(/(<img\b[^>]*?\bsrc=)(["'])[^"']*\2/gi, '$1$2$2');
}

/** Insert filler HTML immediately before the block with the given id (id-based, not brittle string search). */
function insertBeforeBlockId(pg: EdBlock[], id: string, filler: string): string {
  return pg.map((b) => (b.id === id ? filler + b.html : b.html)).join('');
}

function buildEditorialHtml(
  content: BrochureContent,
  tpl: BrochureTemplate,
  measure?: EdMeasureFn,
): Promise<string> {
  return buildEditorialHtmlInner(content, tpl, measure);
}

async function buildEditorialHtmlInner(
  c: BrochureContent,
  tpl: BrochureTemplate,
  measure?: EdMeasureFn,
): Promise<string> {
  const { cover, blocks, head, accent, fillers } = await buildEditorialBlocks(c, tpl);

  // Measure real heights in headless Chrome when possible; any failure → estimates.
  let measured: Record<string, number> | null = null;
  if (measure && blocks.length) {
    try {
      measured = await measure(
        buildEditorialMeasuringHtml(blocks, head, tpl, accent),
        blocks.map((b) => b.id),
      );
    } catch {
      measured = null;
    }
  }
  const hOf = (b: EdBlock) => sanitizeMeasured(measured?.[b.id], b.hEst);
  return composeEditorialPages(c, cover, head, tpl, accent, blocks, hOf, fillers);
}

/** Compact 3D country-silhouette map for the EDITORIAL map plate (opt-in via the "3D"
 *  directive). Reuses the banded silhouette renderer but draws a clean inset — accent
 *  country fill + white city pins + a dotted route + uppercase labels — sized to the
 *  plate's own viewBox, keeping the editorial frame/caption/aesthetic. null → caller
 *  falls back to the raster route map. */
function buildEditorialGeoMap(country: Feat, matched: { name: string; ll: LL }[], accent: string): string | null {
  const W = 680,
    H = 520,
    pad = 34;
  const zone: Rect = { x: pad, y: pad, w: W - 2 * pad, h: H - 2 * pad };
  const onAccent = contrastInk(accent);
  const accentDeep = darken(accent, 0.34);
  const built = buildBasemap3d(country, zone, { accent, accentDeep, onAccent }, 'edmap');
  if (!built) return null;
  const { svgPrefix, project } = built;
  const pts = matched.map((m) => {
    const [px, py] = project(m.ll.lon, m.ll.lat);
    return { name: m.name, px, py };
  });
  const lineCore = onAccent;
  const lineCasing = onAccent === '#ffffff' ? '#15151c' : '#ffffff';
  const pl = pts.map((q) => `${f1(q.px)},${f1(q.py)}`).join(' ');
  const route =
    pts.length >= 2
      ? `<polyline points="${pl}" fill="none" stroke="${lineCasing}" stroke-width="3.6" stroke-dasharray="2 7" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>` +
        `<polyline points="${pl}" fill="none" stroke="${lineCore}" stroke-width="1.7" stroke-dasharray="2 7" stroke-linecap="round" stroke-linejoin="round"/>`
      : '';
  const markerR = 6.2;
  const markers = pts
    .map(
      (q) =>
        `<circle cx="${f1(q.px)}" cy="${f1(q.py)}" r="${markerR}" fill="${onAccent}" stroke="${accentDeep}" stroke-width="1.5"/>` +
        `<circle cx="${f1(q.px)}" cy="${f1(q.py)}" r="2.3" fill="${accent}"/>`,
    )
    .join('');
  // Labels above the pins, stacked apart so a tight cluster never overprints.
  const tags = pts.map((q) => ({ q, ty: q.py - 11 }));
  tags.sort((u, v) => u.ty - v.ty);
  for (let i = 1; i < tags.length; i++) if (tags[i]!.ty - tags[i - 1]!.ty < 17) tags[i]!.ty = tags[i - 1]!.ty + 17;
  const labels = tags
    .map(
      (t) =>
        `<text x="${f1(t.q.px)}" y="${f1(t.ty)}" text-anchor="middle" paint-order="stroke" stroke="${lineCasing}" stroke-width="3.2" stroke-linejoin="round" fill="${onAccent}" style="font:700 13px var(--body);letter-spacing:.4px;text-transform:uppercase">${esc(t.q.name.toUpperCase())}</text>`,
    )
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" style="display:block;width:100%;height:100%">${svgPrefix}${route}${markers}${labels}</svg>`;
}

/** Phase 1 — fetch assets + build every block (no browser). */
async function buildEditorialBlocks(
  c: BrochureContent,
  tpl: BrochureTemplate,
): Promise<{ cover: string; blocks: EdBlock[]; head: string; accent: string; fillers: string[] }> {
  // Brand accent overrides the destination-inferred accent; else infer as today.
  const accent = normalizeAccent(c.__brand?.colors?.accent || c.palette?.accent);

  // ---- gather + fetch assets (parallel) — CANDIDATES per query, then UNIQUE assignment
  // so the cover, feature-spread lead and every page filler are all different photos. ----
  const highlightCards = (c.highlights?.cards ?? []).slice(0, 6);
  // The first highlight becomes the feature-spread LEAD photo; the rest are text-only.
  const fillQ = fillerImageQueries(c).slice(0, 3);
  const [heroC, leadC, ...fillCs] = await Promise.all([
    searchCandidates(c.heroQuery),
    highlightCards[0] ? searchCandidates(highlightCards[0].query) : Promise.resolve([] as string[]),
    ...fillQ.map((q) => searchCandidates(q)),
  ]);
  const assignE = uniquePhotoAssigner();
  const hero = assignE.take(heroC);
  const lead = assignE.take(leadC);
  fillCs.forEach((cands) => assignE.addPool(cands));
  assignE.addPool(heroC);
  assignE.addPool(leadC);
  const fillers = assignE.pool;

  // route map (raster — editorial framed plate; geocoding handled inside). The map
  // is ALWAYS fetched 1280x520 → a fixed aspect the measuring pass can rely on.
  let map = '';
  const cities = routeCities(c); // explicit cities → places → parsed routeLine (reliability)
  if (cities.length >= 2) {
    try {
      map = await routeMapUrl(cities, { color: accent.replace('#', ''), width: 1280, height: 520 });
    } catch {
      map = '';
    }
  }
  // Opt-in 3D country silhouette (the "3D" directive) — geocode the route, resolve the
  // country, and render the silhouette into the editorial map plate (parity with the
  // banded family). Any failure falls back to the raster route map above.
  let map3dSvg = '';
  if (c.__map3d) {
    const placeKeys = c.route?.places?.length
      ? c.route.places.map((p) => ({ short: p.name, key: p.geo || p.name }))
      : cities.map((nm) => ({ short: nm.replace(/,.*$/, ''), key: nm }));
    if (placeKeys.length >= 2) {
      const shortOf = new Map(placeKeys.map((pk) => [pk.key, pk.short] as const));
      // Region-constrained geocoding resolves the country AND fixes pins that would
      // otherwise strand off the silhouette (ambiguous town names).
      const { points, country } = await geocodeRoute(placeKeys.map((p) => p.key));
      if (points.length >= 2 && country) {
        // Resolve each pin's display label; drop duplicate stops (a round-trip repeats a city).
        const seen = new Set<string>();
        const use: { name: string; ll: LL }[] = [];
        for (const ll of points) {
          const name = shortOf.get(ll.name) ?? ll.name.replace(/,.*$/, '');
          const k = name.toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          use.push({ name, ll });
        }
        if (use.length >= 2) map3dSvg = buildEditorialGeoMap(country, use, accent) || '';
      }
    }
  }
  const qr = brandOrFooterQr(c);

  const blocks: EdBlock[] = [];
  let n = 0;

  // 01 — Intro lede (drop-cap)
  if (c.intro && (c.intro.heading || c.intro.body)) {
    n++;
    const body = String(c.intro.body || '').trim();
    const dc = body ? `<span class="dc">${esc(body.charAt(0))}</span>${esc(body.slice(1))}` : '';
    // real .ed-lede p is 13pt over ~150mm (drop-cap inset); estimate biased tall.
    const hEst = ED_HEAD + estLines(body, 150, 13, 0, 0.62) * ED_LINE13 + 8;
    blocks.push({
      id: 'intro',
      html:
        `<section class="ed-sec">${edHead(n, c.intro.kicker || 'Why this journey', c.intro.heading)}` +
        `<div class="ed-lede"><p>${dc}</p></div></section>`,
      hEst,
    });
  }

  // 02 — Highlights feature spread
  if (highlightCards.length) {
    n++;
    const rail = highlightCards
      .map(
        (card, i) =>
          `<div class="it"><span class="no">${String(i + 1).padStart(2, '0')}</span>` +
          `<div><div class="ttl">${esc(card.label)}</div>` +
          (card.caption ? `<div class="cap">${esc(card.caption)}</div>` : '') +
          `</div></div>`,
      )
      .join('');
    const stat = c.highlights?.stat
      ? `<div class="statcard"><div class="big">${esc(c.highlights.stat.big)}</div><div class="lab">${esc(c.highlights.stat.label)}</div></div>`
      : '';
    const leadInner = lead ? `<img src="${esc(lead)}" alt="">` : '';
    const leadTag = highlightCards[0] ? `<span class="tag">${esc(highlightCards[0].label)}</span>` : '';
    blocks.push({
      id: 'highlights',
      html:
        `<section class="ed-sec">${edHead(n, c.highlights?.kicker || 'Highlights', c.highlights?.heading)}` +
        `<div class="ed-spread"><div class="ed-lead">${leadInner}${leadTag}</div>` +
        `<div class="ed-rail">${rail}${stat}</div></div></section>`,
      hEst: 158, // 118mm lead min + head + spacing
    });
  }

  // Pull-quote (the colour pops) — uses the cover tagline / route headline.
  const quoteText = c.__brand?.tagline || c.tagline || c.route?.headline || c.intro?.heading;
  if (quoteText) {
    const byline = c.__brand?.name || c.agencyName;
    blocks.push({
      id: 'quote',
      html:
        `<section class="ed-sec"><div class="ed-quote"><q><span class="big">${esc(quoteText)}</span></q>` +
        (byline ? `<div class="by">${esc(byline)}</div>` : '') +
        `</div></section>`,
      hEst: 94, // 32mm padding + ~4 display-italic lines + .by
    });
  }

  // 03 — Itinerary (big accent day numerals). CHUNKED at ≤8 days/page so a long
  // trip paginates instead of overflowing one page. A micro-trip (≤2 days) drops
  // the elastic fill so a single card never stretches into a giant empty grid.
  const days = c.itinerary?.days ?? [];
  if (days.length) {
    n++;
    const micro = days.length <= 2;
    const chunks = chunk(days, ED_ITIN_CHUNK);
    let dayBase = 0;
    chunks.forEach((chunkDays, ci) => {
      const items = chunkDays
        .map(
          (d, i) =>
            `<div class="ed-day"><span class="n">${String(dayBase + i + 1).padStart(2, '0')}</span>` +
            `<div><div class="ttl">${esc(d.title)}</div><div class="tx">${esc(d.text)}</div></div></div>`,
        )
        .join('');
      dayBase += chunkDays.length;
      const headHtml =
        ci === 0
          ? edHead(n, c.itinerary?.kicker || 'Day by day', c.itinerary?.heading)
          : edHead(n, (c.itinerary?.kicker || 'Day by day') + ' · cont.', '');
      const fillCls = micro ? '' : ' fill';
      blocks.push({
        id: chunks.length > 1 ? `itin-${ci}` : 'itin',
        html:
          `<section class="ed-sec${micro ? '' : ' ed-itin'}">${headHtml}` +
          `<div class="ed-days${fillCls}">${items}</div></section>`,
        hEst: ED_HEAD + Math.ceil(chunkDays.length / 2) * 34 + 8,
        grow: !micro, // elastic only when there are enough days to fill a page
      });
    });
  }

  // 04 — Route map (editorial plate): 3D country silhouette when requested, else raster.
  if (map || map3dSvg) {
    n++;
    const capWords =
      c.routeLine ||
      (cities[0] && cities[cities.length - 1]
        ? `${cities[0]!.split(',')[0]} — ${cities[cities.length - 1]!.split(',')[0]}`
        : 'The route');
    const plate = map3dSvg
      ? `<div class="ed-map ed-map--3d">${map3dSvg}</div>`
      : `<div class="ed-map"><img src="${esc(map)}" alt="Route map"></div>`;
    blocks.push({
      id: 'map',
      html:
        `<section class="ed-sec">${edHead(n, c.route?.kicker || 'The route', c.route?.heading)}` +
        (c.route?.headline ? `<div class="ed-route-words">${esc(c.route.headline)}</div>` : '') +
        plate +
        `<div class="ed-mapcap"><span class="pip"></span><span>${esc(capWords)}</span></div>` +
        `</section>`,
      hEst: map3dSvg ? 178 : 132, // 3D plate (680:520) is taller than the raster (1280:520)
    });
  }

  // Flexible extra sections (any layout). A 'cards'/'gallery' section is rendered
  // as a clean label→caption grid here (the editorial family doesn't fetch section
  // photos) so its content is never dropped — parity with the banded family.
  (c.sections ?? []).forEach((s, si) => {
    if (!(s.heading || s.body || s.items?.length || s.bullets?.length || s.cards?.length)) return;
    n++;
    let inner = '';
    let hEst = ED_HEAD;
    const rows = s.items?.length
      ? s.items
      : s.cards?.length
        ? s.cards.map((cd) => ({ k: cd.label, v: cd.caption || '' }))
        : null;
    if (rows) {
      inner =
        `<div class="ed-incl">` +
        rows.map((it) => `<div class="row"><div class="k">${esc(it.k)}</div><div class="v">${esc(it.v)}</div></div>`).join('') +
        `</div>`;
      hEst += Math.ceil(rows.length / 2) * 22 + 6;
    } else {
      inner =
        `<div class="ed-prose">` +
        (s.body ? `<p>${esc(s.body)}</p>` : '') +
        (s.bullets?.length ? `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '') +
        `</div>`;
      hEst += estLines(s.body || '', 150, 10.5, 0, 0.62) * ED_LINE10 + (s.bullets?.length || 0) * 7 + 6;
    }
    blocks.push({ id: `sec-${si}`, html: `<section class="ed-sec">${edHead(n, s.kicker, s.heading)}${inner}</section>`, hEst });
  });

  // 05 — Inclusions (drop empty/placeholder rows so the band reflects only real content)
  const inclItems = (c.inclusions?.items ?? []).filter((it) => String(it?.k ?? '').trim() || String(it?.v ?? '').trim());
  if (inclItems.length) {
    n++;
    const rows = inclItems
      .map((it) => `<div class="row"><div class="k">${esc(it.k)}</div><div class="v">${esc(it.v)}</div></div>`)
      .join('');
    blocks.push({
      id: 'incl',
      html:
        `<section class="ed-sec">${edHead(n, c.inclusions?.kicker || "What's included", c.inclusions?.heading)}` +
        `<div class="ed-incl">${rows}</div></section>`,
      hEst: ED_HEAD + Math.ceil(inclItems.length / 2) * 22 + 6,
    });
  }

  // Adaptive fast-facts band (page-filler that adapts per destination).
  const factsHtml = editorialFacts(c);
  if (factsHtml) {
    n++;
    blocks.push({
      id: 'facts',
      html: `<section class="ed-sec">${edHead(n, 'Good to know', 'At a glance')}${factsHtml}</section>`,
      hEst: 54,
    });
  }

  // 06 — Pricing — only when REAL priced rows exist (a row needs an amount). No brief
  // pricing → no pricing block (never a blank/placeholder table).
  const priceRows = (c.pricing?.rows ?? []).filter((r) => String(r?.value ?? '').trim());
  if (priceRows.length) {
    n++;
    const rows = priceRows
      .map(
        (r) =>
          `<div class="r${r.emphasize ? ' hero' : ''}"><span class="lbl">${esc(r.label)}</span><span class="val">${esc(r.value)}</span></div>`,
      )
      .join('');
    const noteLines = c.pricing?.note ? estLines(c.pricing.note, 150, 10, 0, 0.62) : 0;
    blocks.push({
      id: 'price',
      html:
        `<section class="ed-sec">${edHead(n, c.pricing?.kicker || 'Investment', c.pricing?.heading)}` +
        `<div class="ed-price">${rows}</div>` +
        (c.pricing?.note ? `<div class="ed-price-note">${esc(c.pricing.note)}</div>` : '') +
        `</section>`,
      hEst: ED_HEAD + priceRows.length * 14 + noteLines * 6 + 6,
    });
  }

  // CTA / footer — the LAST block, pinned to the page bottom by an elastic spacer.
  // Contacts/socials MERGE the user's Brand Kit with the composer's own (so a kit
  // number always shows); the block renders whenever ANY of those exist — even if
  // the composer omitted `footer` entirely (brand-kit-only footer).
  const ctaContacts = footerContactLines(c);
  const ctaSocials = footerSocials(c);
  if (c.footer?.cta || ctaContacts.length || ctaSocials.length || qr) {
    const social = ctaSocials
      .map((s) => `<img src="https://cdn.simpleicons.org/${encodeURIComponent(s.toLowerCase())}/ffffff" alt="">`)
      .join('');
    const meta = ctaContacts.map((l) => esc(l)).join('<br>');
    const chkItems = c.footer?.checklist ?? [];
    const chk = chkItems.length
      ? `<ul class="chk">${chkItems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
      : '';
    // Content-aware over-estimate so the real CTA never clips on the fallback path.
    const hEst = Math.max(
      70,
      26 +
        (c.footer?.cta ? 20 : 0) +
        (c.footer?.ctaSub ? 8 : 0) +
        chkItems.length * 7 +
        ctaContacts.length * 5 +
        (social ? 12 : 0) +
        (qr ? 34 : 0),
    );
    blocks.push({
      id: 'cta',
      html:
        `<section class="ed-sec"><div class="ed-cta"><div>` +
        (c.footer?.cta
          ? `<div class="big"><span class="em">${esc(c.footer.cta)}</span>${c.footer?.ctaSub ? `<br>${esc(c.footer.ctaSub)}` : ''}</div>`
          : '') +
        chk +
        (meta ? `<div class="meta">${meta}</div>` : '') +
        (social ? `<div class="soc">${social}</div>` : '') +
        `</div>` +
        (qr ? `<div class="qr"><img src="${esc(qr)}" alt="QR"></div>` : '') +
        `</div></section>`,
      hEst,
      elastic: true,
    });
  }

  const head = fontsLinkEditorial(tpl.fonts.display, tpl.fonts.body);
  return { cover: editorialCover(c, hero), blocks, head, accent, fillers };
}

/** Phase 2 — a flat measuring document: one column, fixed-geometry probes, NO
 *  remote images, so heights are deterministic and the pass hits no network. */
function buildEditorialMeasuringHtml(
  blocks: EdBlock[],
  head: string,
  tpl: BrochureTemplate,
  accent: string,
): string {
  const themeVars = resolveEditorialVars(tpl, accent);
  const probeCss = `
.ed-probe{width:170mm;margin:0;padding:0;position:relative}
.ed-probe .ed-sec{margin:0 !important}
.ed-probe .ed-itin{display:block !important;flex:0 0 auto !important}
.ed-probe .ed-days.fill{display:grid !important;flex:0 0 auto !important;align-content:start !important}
.ed-probe .ed-lead{min-height:118mm}
.ed-probe .ed-map{aspect-ratio:1280/520}
.ed-probe .ed-map img{height:100%}
.ed-probe .ed-map--3d{aspect-ratio:680/520}
.ed-probe .ed-cta .qr img{width:30mm;height:30mm}
.ed-probe .ed-cta .soc img{width:17px;height:17px}
`;
  const body = blocks
    .map((b) => `<div class="ed-probe" data-ed-id="${b.id}">${stripImgSrc(b.html)}</div>`)
    .join('');
  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">${head}` +
    `<style>${themeVars}${EDITORIAL_CSS}${tpl.css}${probeCss}</style></head><body>${body}</body></html>`
  );
}

/** Phase 3 — pack blocks into A4 pages from resolved heights + adaptive fill. */
function composeEditorialPages(
  c: BrochureContent,
  cover: string,
  head: string,
  tpl: BrochureTemplate,
  accent: string,
  blocks: EdBlock[],
  hOf: (b: EdBlock) => number,
  fillers: string[] = [],
): string {
  // RESERVE a strip for the interior brand mark so the LOGO always wins: content is
  // packed into (and padded to) a reduced area that clears the mark's corner — so a
  // bigger top/bottom mark pushes the section grammar out of its way (measure-and-flow
  // reflows; it never clips or overprints). The page's own padding already gives the
  // mark ~12mm (top) / ~7mm (bottom) of clearance, so we only reserve the EXCESS.
  const markCorner = runMarkCorner(c);
  const markScale = interiorMarkScale(c); // band scale wins over the single mark's
  const markH = markCorner && markScale != null ? customMarkH(markScale, markCorner, 'editorial') : 0;
  const markTop = markH > 0 && markCorner!.startsWith('top'); // top-* (incl. centre)
  const markBottom = markH > 0 && markCorner!.startsWith('bottom');
  const reserveTop = markTop ? Math.max(0, round1(markH - 6)) : 0;
  const reserveBottom = markBottom ? Math.max(0, round1(markH - 1)) : 0;
  const reserve = reserveTop + reserveBottom;
  const usable = ED_USABLE - reserve;
  const padStyle = reserveTop
    ? ` style="padding-top:${round1(19 + reserveTop)}mm"`
    : reserveBottom
      ? ` style="padding-bottom:${round1(16 + reserveBottom)}mm"`
      : '';

  // ---- Pack: a page can never exceed `usable` because heights are real and the
  //      real .ed-sec gap is accounted for; ED_SAFETY biases toward a spill. ----
  // Greedy pack from REAL heights, so the hard clip never fires. We do NOT force the
  // itinerary onto a fresh page (measured heights + day-chunking paginate it
  // correctly); forcing it stranded short neighbours on near-empty pages.
  const pages: EdBlock[][] = [];
  let cur: EdBlock[] = [];
  let used = 0;
  for (const b of blocks) {
    const h = hOf(b);
    const gap = cur.length ? ED_SEC_GAP : 0;
    if (cur.length && used + gap + h + ED_SAFETY > usable) {
      pages.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(b);
    used += (cur.length > 1 ? ED_SEC_GAP : 0) + h;
  }
  if (cur.length) pages.push(cur);

  const parts: string[] = [cover];
  // Interior running mark — corner/side/size from the shared `runMarkCorner` (prompt
  // enum OR the visual placer's custom corner). Absolute + zero flow height.
  const runMark = editorialRunMark(c);
  let sealUsed = false;
  // Hand out each filler photo AT MOST ONCE across all pages (never reuse an image).
  let edFc = 0;
  const takeFill = () => (edFc < fillers.length ? fillers[edFc++]! : '');
  // Varied photo captions (places/highlights), so the tagline isn't echoed everywhere.
  const takeCaption = makeCaptionPicker(c);

  pages.forEach((pg, pi) => {
    const isLast = pi === pages.length - 1;
    const hasElastic = pg.some((b) => b.elastic);
    const oversized = pg.length === 1 && hOf(pg[0]!) > usable; // pathological single block
    const pageUsed = pg.reduce((s, b, i) => s + (i ? ED_SEC_GAP : 0) + hOf(b), 0);
    const room = usable - pageUsed;
    let html: string;

    if (hasElastic) {
      // CTA page: pin the CTA to the bottom and USE the gap above it. A large unused
      // gap becomes a centred chapter-close seal (once); otherwise a destination photo
      // grows (flex:1, min-height:0 so it only takes the REAL leftover — measured
      // heights are biased tall, so actual room ≥ computed room and it never overflows)
      // and fills the space instead of a bare cream void.
      const img = takeFill();
      let filler: string;
      if (img) {
        // Prefer a closing destination photo — it fills the gap with imagery AND pins
        // the CTA to the bottom (no floating seal stranded in whitespace).
        const cap = takeCaption();
        filler =
          `<div class="ed-fill--photo" style="min-height:0"><img src="${esc(img)}" alt="">` +
          (cap ? `<span class="cap">${cap}</span>` : '') +
          `</div>`;
      } else if (room > 70 && !sealUsed) {
        sealUsed = true;
        filler = `<div class="ed-spacer"></div>${editorialSeal(c)}<div class="ed-spacer"></div>`;
      } else {
        filler = `<div class="ed-spacer"></div>`;
      }
      html = insertBeforeBlockId(pg, 'cta', filler);
    } else {
      // Ordinary content page (incl. the itinerary, which now packs its day grid
      // tight at the top rather than stretching rows apart). Pack from the TOP and
      // absorb leftover height into a destination photo (preferred) or a restrained
      // colophon so the page NEVER reads as stranded whitespace.
      // The very last ordinary page still closes with the chapter seal when unused.
      const body = pg.map((b) => b.html).join('');
      if (isLast && room > 40 && !sealUsed) {
        sealUsed = true;
        // Fill the gap above the closing seal with a destination photo (grows to absorb
        // only the real leftover) rather than a bare spacer void; seal closes at bottom.
        const img = takeFill();
        const mid = img
          ? `<div class="ed-fill--photo" style="min-height:0"><img src="${esc(img)}" alt=""></div>`
          : `<div class="ed-spacer"></div>`;
        html = body + mid + editorialSeal(c);
      } else {
        html = body + editorialFill(c, takeFill, takeCaption, room);
      }
    }

    // A single block taller than a page escapes the hard clip via a flow page that
    // grows (keeping inner margins) instead of clipping.
    if (oversized) {
      parts.push(`<div class="ed-page ed-page--flow"><div class="ed-flowpad"${padStyle}>${runMark}${html}</div></div>`);
      return;
    }
    // The running mark renders on EVERY interior page (consistency — no "missing on
    // page 3"). The reserve strip (padStyle) keeps content clear of it; on the quote
    // page the mark sits on the accent band's frosted plate, well above the centred
    // quote text. The cover is handled separately (parts[0], no mark).
    parts.push(`<div class="ed-page"${padStyle}>${runMark}${html}</div>`);
  });

  // Safety net: never emit a blank interior page. Measurement variance / an empty
  // section can occasionally strand a page with only the running mark and no real
  // content — drop any interior page that carries no text AND no image. The cover
  // (parts[0]) is always kept; a photo-filler page (has <img>) is intentional content.
  const kept = [parts[0]!, ...parts.slice(1).filter(edPageHasContent)];

  const themeVars = resolveEditorialVars(tpl, accent);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">${head}<style>${themeVars}${EDITORIAL_CSS}${tpl.css}</style></head><body>${kept.join('')}</body></html>`;
}

/** True if an `.ed-page` HTML string carries real content — any image, or any text
 *  once the absolute running-mark overlay and all tags are stripped. */
function edPageHasContent(pageHtml: string): boolean {
  const body = pageHtml.replace(/<div class="ed-runmark[\s\S]*?<\/div>/gi, '');
  if (/<img\b/i.test(body)) return true;
  return body.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length > 0;
}

// ============================================================================
// BANDED FAMILY — full-bleed composed-page "press banded" engine.
// Reproduces the TMC reference style adaptively: edge-to-edge colour bands,
// a photo-led cover, a dotted-timeline experience page, a signature map page,
// and a logistics/pricing page — paginated by COUNT in TS so a poster page is
// never fragmented and whitespace is structurally impossible (elastic last band).
// ============================================================================

// ---- small helpers ----
function clampText(s: unknown, max: number): string {
  const t = String(s ?? '').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out.length ? out : [[]];
}

/** Like chunk, but balances items evenly across the needed pages (8 items, cap
 * 5 → 4+4, not 5+3) so no page ends up sparse. */
function balancedChunk<T>(arr: T[], cap: number): T[][] {
  if (!arr.length) return [[]];
  const pages = Math.ceil(arr.length / cap);
  const per = Math.ceil(arr.length / pages);
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += per) out.push(arr.slice(i, i + per));
  return out;
}

// ---- adaptive 3-tone palette (locked neutrals + contrast guards) ----
function relLum(hex: string): number {
  const c = parseHex(hex);
  return c ? (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255 : 0.3;
}

/** Proper sRGB relative luminance (WCAG) — used for the contrast guards below. */
function wcagLum(hex: string): number {
  const c = parseHex(hex);
  if (!c) return 0.3;
  const f = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

/** WCAG contrast ratio between two hex colours (1..21). */
function contrastRatio(a: string, b: string): number {
  const la = wcagLum(a);
  const lb = wcagLum(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Nudge `fg` toward white/black (whichever raises contrast against `bg`) until it
 *  clears `target` — so an accent stays legible as TEXT on any surface (a too-light
 *  accent on white is darkened; a dark accent on a dark band is lightened). */
function legibleOn(fg: string, bg: string, target = 4.0): string {
  if (!parseHex(fg)) return fg;
  const bgDark = wcagLum(bg) < 0.5;
  let cur = fg;
  for (let i = 0; i < 14 && contrastRatio(cur, bg) < target; i++) {
    cur = bgDark ? lighten(cur, 0.1) : darken(cur, 0.1);
  }
  return cur;
}

function bandedScheme(accent: string, accent2?: string): Record<string, string> {
  const A = normalizeAccent(accent);
  const lum = relLum(A);
  // Neutrals are LOCKED so the 3 tones stay distinct for any accent. A near-black
  // accent flips the "ink" tone to warm cream so accent !== ink band.
  let bandInk = '#111114';
  let onInk = '#ffffff';
  if (lum < 0.16) {
    bandInk = '#f3efe8';
    onInk = contrastInk(bandInk);
  }
  // Thin decoration (dots/leaders) must survive on white paper: darken a pale accent.
  const dot = lum > 0.55 ? darken(A, 0.3) : A;
  const scheme: Record<string, string> = {
    '--accent': A,
    '--accent-dark': darken(A, 0.26),
    '--accent-deep': darken(A, 0.3),
    '--accent-bright': lighten(A, 0.18),
    '--on-accent': contrastInk(A),
    '--band-ink': bandInk,
    '--on-ink': onInk,
    // Accent used as TEXT, made legible on each surface: --accent-ink on white paper
    // (a too-pale accent is darkened); --accent-on-ink on the neutral band (a dark
    // accent on the dark band is lightened, or stays dark on a flipped-cream band).
    '--accent-ink': legibleOn(A, '#ffffff', 4.2),
    '--accent-on-ink': legibleOn(A, bandInk, 4.2),
    // The cover is always a deep neutral (never the flippable band tone) so its white
    // lockup never lands on a cream band when the accent is near-black.
    '--cover-bg': '#111114',
    '--paper': '#ffffff',
    '--bg': '#ffffff',
    '--ink': '#15151c',
    '--surface': '#ffffff',
    '--accent-wash': lighten(A, 0.92),
    '--accent-tint': lighten(A, 0.74),
    '--accent-soft': lighten(A, 0.4),
    '--line': lighten(A, 0.8),
    '--muted': mix('#6b6b73', A, 0.12),
    '--dot': dot,
  };
  if (accent2 && parseHex(accent2)) {
    if (Math.abs(relLum(accent2) - lum) > 0.15) scheme['--accent2'] = toHex(parseHex(accent2)!);
  }
  return scheme;
}

function resolveBandedVars(tpl: BrochureTemplate, accent: string, accent2?: string): string {
  const scheme = bandedScheme(accent, accent2);
  const overrides = tpl.theme(accent, accent2) || {};
  const merged = { ...scheme, ...overrides };
  // Recompute on-colours if a template re-tuned the neutrals/accent (keeps contrast).
  if (overrides['--band-ink'] && !overrides['--on-ink']) merged['--on-ink'] = contrastInk(overrides['--band-ink']);
  if (overrides['--accent'] && !overrides['--on-accent']) merged['--on-accent'] = contrastInk(overrides['--accent']);
  // Heavy display faces (Anton/Archivo Black) are single-weight: use a condensed/sans
  // fallback stack, NOT the flow family's serif default.
  if (!merged['--display'])
    merged['--display'] = `'${tpl.fonts.display}', Impact, 'Arial Narrow Bold', 'Arial Narrow', sans-serif`;
  if (!merged['--body'])
    merged['--body'] = `'${tpl.fonts.body}', system-ui, -apple-system, Helvetica, Arial, sans-serif`;
  // The cover wordmark gets an elegant serif (refined cover → bold interior).
  if (!merged['--cover-display'])
    merged['--cover-display'] = `'${tpl.coverFont || 'Playfair Display'}', Georgia, 'Times New Roman', serif`;
  return `:root{${Object.entries(merged)
    .map(([k, v]) => `${k}:${v}`)
    .join(';')}}`;
}

/** Banded Google-Fonts link: requests the display family WITHOUT a weight axis
 * (single-weight display faces 404 the whole stylesheet if you ask for 700), the
 * body across weights, and an optional elegant serif for the cover wordmark. */
function fontsLinkBanded(display: string, body: string, cover?: string): string {
  const lc = (s: string) => s.trim().toLowerCase();
  const fams: string[] = [`family=${fontParam(display)}`];
  if (lc(body) !== lc(display)) fams.push(`family=${fontParam(body)}:wght@300;400;500;600;700;800`);
  else fams[0] = `family=${fontParam(display)}:wght@400;700;800`;
  const cv = cover || 'Playfair Display';
  if (lc(cv) !== lc(display) && lc(cv) !== lc(body)) fams.push(`family=${fontParam(cv)}:ital,wght@0,400;0,500;0,600;0,700;1,400`);
  return `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?${fams.join('&')}&display=swap" rel="stylesheet">`;
}

// ---- inline SVG icon masks (alpha masks; render reliably in Chromium) ----
const PIN_MASK =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 30'%3E%3Cpath d='M12 0C5 0 0 5 0 12c0 9 12 18 12 18s12-9 12-18C24 5 19 0 12 0z'/%3E%3C/svg%3E\") center/contain no-repeat";
const CHECK_MASK =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M20 6 9 17l-5-5' fill='none' stroke='%23000' stroke-width='3'/%3E%3C/svg%3E\") center/contain no-repeat";

const BANDED_CSS = `
*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
@page{size:A4;margin:0}
html,body{margin:0;padding:0;background:var(--band-ink)}
body{font-family:var(--body);color:var(--ink);font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased}
img{display:block;max-width:100%}
.page{position:relative;width:210mm;height:297mm;overflow:hidden;break-after:page;background:var(--paper);color:var(--ink);display:grid}
.page:last-child{break-after:auto}

/* ---- shared band atoms ---- */
.band--accent{background:var(--accent);color:var(--on-accent)}
.band--ink{background:var(--band-ink);color:var(--on-ink)}
.band--paper{background:var(--paper);color:var(--ink)}
.kick{font:700 10.5px/1 var(--body);letter-spacing:.26em;text-transform:uppercase;color:var(--accent-ink);margin-bottom:5px}
/* A kicker that sits ON an accent band must read against it, not vanish into it. */
.exp__why .kick,.log__band-accent .kick{color:var(--on-accent);opacity:.9}
.band--accent .kick,.band--ink .kick{color:currentColor;opacity:.82}
h1,h2,h3{font-family:var(--display);font-weight:400;line-height:.96;letter-spacing:.005em}
.page h2{font-family:var(--display);font-weight:400;font-size:31px;text-transform:uppercase;line-height:.98;margin:0 0 6mm}

/* ============ COVER — elegant: centred lockup over a soft disc, clean rows, pill ============ */
.cover{display:block;background:var(--cover-bg);color:#fff}
.cover .hero{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0}
.cover .veil{position:absolute;inset:0;z-index:1;background:linear-gradient(180deg,rgba(8,8,14,.46),rgba(8,8,14,.16) 34%,rgba(8,8,14,.30) 64%,rgba(8,8,14,.78))}
.cover .disc{position:absolute;left:50%;top:47%;transform:translate(-50%,-50%);width:150mm;height:150mm;border-radius:50%;background:var(--accent);opacity:.84;z-index:2}
.cover .mark{position:absolute;top:13mm;left:16mm;right:16mm;display:flex;justify-content:space-between;align-items:center;min-height:18mm;font:600 10px/1 var(--body);letter-spacing:.24em;text-transform:uppercase;z-index:4;color:#fff;opacity:.95}
.cover .mark>span{opacity:.95}
.cover .lock{position:absolute;left:0;right:0;top:47%;transform:translateY(-50%);text-align:center;padding:0 26mm;z-index:4}
.cover .lock .pre{font:600 11px/1 var(--body);letter-spacing:.34em;text-transform:uppercase;opacity:.92;margin-bottom:13px}
.cover .lock h1{font-family:var(--cover-display);font-weight:700;font-size:72px;line-height:1;color:#fff;text-shadow:0 2px 28px rgba(0,0,0,.42)}
.cover .lock .sub{font:400 19px/1.32 var(--body);margin-top:12px;color:#fff;opacity:.97;text-shadow:0 1px 12px rgba(0,0,0,.45)}
.cover .lock .route{font:600 11px/1 var(--body);letter-spacing:.22em;text-transform:uppercase;margin-top:14px;opacity:.92}
.cover .agency{position:absolute;left:17mm;bottom:15mm;z-index:4;font:400 11px/1.55 var(--body);opacity:.95}
.cover .agency b{display:block;font:700 14px/1.3 var(--body);letter-spacing:.01em}
.cover .pill{position:absolute;right:17mm;bottom:15mm;z-index:4;background:var(--accent);color:var(--on-accent);border-radius:999px;padding:9px 19px;font:700 10px/1 var(--body);letter-spacing:.13em;text-transform:uppercase}

/* ---- BRAND LOGO (uploaded; placed per brand.placement) ---- */
/* Every brand mark sits on a frosted plate. The engine can't know the uploaded
   logo's own luminance, and a light/thin logo on a photo or accent band simply
   vanishes — so a soft backing plate is the universal default (NOT gated on an
   onDark hint). The .bare class opts out only when the brand flags a light bg. */
.cover .brandmark,.cover .mark .mlogo,.cover .freelogo,.page .runmark{
  --plate:rgba(255,255,255,.94);
  background:var(--plate);border-radius:3px;
  box-shadow:0 2px 14px rgba(0,0,0,.30)}
.cover .brandmark.bare,.cover .mark .mlogo.bare,.cover .freelogo.bare,.page .runmark.bare{
  background:transparent;box-shadow:none}
/* CUSTOM free cover logo (visual placer): centred on the dragged point, width set
   inline as a % of the cover. The cover is a fixed photo composition so this never
   collides with flowed content. */
.cover .freelogo{position:absolute;transform:translate(-50%,-50%);z-index:6;display:flex;justify-content:center;padding:3mm 4mm}
.cover .freelogo img{display:block;width:100%;height:auto;object-fit:contain}
.cover .freelogo.bare img{filter:drop-shadow(0 2px 12px rgba(0,0,0,.5))}
/* Prominent cover logo (cover / every-page / footer placements): a centred mark
   above the lockup, on the disc — sized adaptively, comfortably padded. */
.cover .brandmark{position:absolute;left:50%;top:17mm;transform:translateX(-50%);z-index:5;display:flex;justify-content:center;padding:3.5mm 5mm}
.cover .brandmark img{display:block;width:auto;height:auto;max-height:26mm;max-width:88mm;object-fit:contain}
.cover .brandmark.bare img{filter:drop-shadow(0 2px 12px rgba(0,0,0,.5))}
/* Cover masthead corner (top-left/top-right placement) — the logo OWNS that
   corner; the opposite-side text mark stays. Larger + clearly inset, never a
   speck floating on the sky. */
.cover .mark .mlogo{display:inline-flex;align-items:center;padding:2.5mm 3.5mm}
.cover .mark .mlogo img{display:block;width:auto;height:auto;max-height:18mm;max-width:68mm;object-fit:contain}
.cover .mark .mlogo.bare img{filter:drop-shadow(0 1px 6px rgba(0,0,0,.45))}
/* Per-page running mark — absolute, zero flow height. "Subtle" by the user's
   brief: a compact wordmark inset from the trim, sized to read clearly without
   competing with the page content. Sits in the very top margin; the plate is
   tight so it tucks above a band heading (which begins ~12mm) without colliding. */
.page .runmark{position:absolute;top:4mm;z-index:9;pointer-events:none;display:inline-flex;align-items:center;padding:1.4mm 2mm}
.page .runmark.left{left:10mm}
.page .runmark.right{right:10mm}
.page .runmark.center{left:50%;transform:translateX(-50%)}
.page .runmark.bottom{top:auto;bottom:6mm}
.page .runmark img{display:block;width:auto;height:auto;max-height:10mm;max-width:46mm;object-fit:contain}
.page .runmark.bare img{filter:drop-shadow(0 1px 6px rgba(0,0,0,.45))}
/* CUSTOM-sized running mark: HEIGHT is set inline (corner-safe, clamped); width is
   auto so the corner plate stays snug. Still corner-pinned + zero flow height, so it
   can never push content or add a page. */
.page .runmark.custom img{width:auto;max-height:none;max-width:58mm}
/* Interior logo BAND (banded, header only) — full-width strip; each logo at centre x,
   shared inline height. The header bands reserve the --hr strip so text sits below it. */
.page .logoband{position:absolute;left:0;right:0;top:6mm;z-index:9;height:0;pointer-events:none}
.page .logoband__img{position:absolute;top:0;transform:translateX(-50%);width:auto;max-width:46mm;object-fit:contain}
.page .logoband__img.bare{filter:drop-shadow(0 1px 6px rgba(0,0,0,.45))}

/* ============ EXPERIENCE PAGE ============ */
.exp{grid-template-columns:69mm 1fr;grid-template-rows:1fr auto}
.exp__rail{grid-column:1;grid-row:1;display:grid;grid-auto-rows:1fr;overflow:hidden}
.exp__rail figure{position:relative;overflow:hidden;margin:0;background:var(--accent-deep)}
.exp__rail img{width:100%;height:100%;object-fit:cover}
.exp__rail figcaption{position:absolute;left:0;right:0;bottom:0;padding:10mm 6mm 5mm;color:#fff;font:800 11.5px/1.15 var(--body);letter-spacing:.04em;text-transform:uppercase;background:linear-gradient(0deg,rgba(0,0,0,.85),transparent)}
.exp__main{grid-column:2;grid-row:1;display:flex;flex-direction:column;min-height:0}
.exp__why{background:var(--accent);color:var(--on-accent);padding:13mm 15mm}
.exp__why.has-mark{padding-top:var(--hr,16mm)}
.exp__why h2{color:var(--on-accent)}
.exp__why p{font-size:12.5px;line-height:1.6;opacity:.97;margin-top:2mm;max-width:120mm}
.exp__list{background:var(--paper);color:var(--ink);padding:12mm 15mm;flex:1;overflow:hidden}
.exp__list.has-mark{padding-top:var(--hr,16mm)}
.exp__close{grid-column:1/3;grid-row:2;background:var(--band-ink);color:var(--on-ink);display:grid;grid-template-columns:62mm 1fr;min-height:44mm}
.exp__close figure{margin:0;overflow:hidden;background:var(--accent-deep)}
.exp__close img{width:100%;height:100%;object-fit:cover}
.exp__close .copy{padding:11mm 14mm;align-self:center;display:flex;align-items:baseline;gap:7mm}
.exp__close .big{font-family:var(--display);font-weight:400;font-size:54px;line-height:.8;color:var(--accent-on-ink)}
.exp__close .ct{font:400 13px/1.5 var(--on-ink);opacity:.92}
.exp__close .ct b{display:block;font:800 13px/1.3 var(--body);text-transform:uppercase;letter-spacing:.12em;margin-bottom:1mm}

/* dotted timeline */
.tl{list-style:none}
.tl li{position:relative;padding:0 0 5.5mm 11mm}
.tl li:last-child{padding-bottom:0}
.tl li::before{content:"";position:absolute;left:0;top:1mm;width:3mm;height:3mm;border-radius:50%;background:var(--dot);box-shadow:0 0 0 1.4mm var(--paper);z-index:1}
.tl li::after{content:"";position:absolute;left:1.5mm;top:1mm;bottom:-4mm;border-left:2px dotted var(--dot);transform:translateX(-1px)}
.tl li:last-child::after{display:none}
.tl .t{font:400 14px/1.12 var(--display);text-transform:uppercase;color:var(--ink);letter-spacing:.01em}
.tl .d{font:400 11px/1.4 var(--body);color:var(--muted);margin-top:.6mm}

/* ============ MAP PAGE (annotated: real 2D basemap or 3D tile + leader-line callouts) ============ */
.map--anno{display:block;position:relative;background:var(--paper)}
.map__stage{position:absolute;left:0;right:0;top:0;overflow:hidden}
.map__stage.geo{background:radial-gradient(125% 100% at 50% 40%,var(--accent-wash),var(--paper) 80%)}
/* 2D real basemap raster (default): positioned in px to align with the SVG overlay */
.map__base{position:absolute;display:block;object-fit:fill;box-shadow:0 2.5mm 6mm rgba(20,20,28,.18)}
/* accent veil over the raster basemap (below the SVG markers): on-brand, denser feel */
.map__tint{position:absolute;pointer-events:none;background:var(--accent);mix-blend-mode:multiply;opacity:.16}
/* overlay SVG (markers/leaders/route + 3D silhouette paths) — no filter so lines stay crisp */
.map__svg{position:absolute;inset:0;width:100%;height:100%;display:block}
/* top kicker strip — fills the header on every page */
.map__kicker{position:absolute;left:15mm;right:15mm;top:5mm;height:9mm;z-index:4;display:flex;justify-content:space-between;align-items:flex-end;border-bottom:.4mm solid var(--accent);padding-bottom:1.5mm}
.map__kicker.has-mark{top:var(--hr,16mm);height:auto}
.map__kicker .kk{font:700 11px/1 var(--body);text-transform:uppercase;letter-spacing:.22em;color:var(--accent-ink)}
.map__kicker .eye{font:400 15px/1 var(--display);text-transform:uppercase;letter-spacing:.04em;color:var(--ink)}
.map__note{position:absolute;right:1.6mm;top:50%;transform:translateY(-50%) rotate(180deg);writing-mode:vertical-rl;font:400 7px/1 var(--body);color:var(--ink);opacity:.42;letter-spacing:.14em;text-transform:uppercase;z-index:4}
/* callout cards — HTML in the SAME box as the SVG, so the leader lines land on the pins */
.mcard{position:absolute;z-index:3;display:flex;flex-direction:column;justify-content:center}
.mcard.r{text-align:right;align-items:flex-end}
.mcard .nm{display:flex;align-items:center;gap:1.6mm;font:400 15px/1 var(--display);text-transform:uppercase;color:var(--accent-ink);letter-spacing:.02em}
.mcard.r .nm{flex-direction:row-reverse}
.mcard .nm i{width:3.2mm;height:4mm;flex:none;background:var(--accent);-webkit-mask:${PIN_MASK};mask:${PIN_MASK}}
.mcard .st{font:800 11px/1.1 var(--body);text-transform:uppercase;color:var(--ink);letter-spacing:.02em;margin:1.6mm 0 .9mm}
.mcard p{font:400 9.5px/1.34 var(--body);color:var(--muted)}
.mcard .ac{font:600 9.5px/1.36 var(--body);color:var(--ink);margin-top:1.2mm}
.mcard .ac b{color:var(--accent-ink)}
/* accent headline + ink closing bands (placed absolutely; heights set inline). Text is
   centred both axes; line-height kept ~1 so all-caps sits at the true optical centre. */
.map__headline{position:absolute;left:0;right:0;background:var(--accent);color:var(--on-accent);display:flex;align-items:center;justify-content:center;text-align:center;padding:0 15mm;z-index:5}
.map__headline h2{font-size:34px;color:var(--on-accent);margin:0;line-height:1}
.map__close{position:absolute;left:0;right:0;bottom:0;background:var(--band-ink);color:var(--on-ink);display:flex;align-items:center;justify-content:center;text-align:center;padding:0 15mm;font:400 12px/1.45 var(--body);z-index:5}
/* no-geo fallback (raster route map / hatched panel + a simple city list) */
.fb__img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:saturate(.95) contrast(1.03)}
.fb__img.is-empty{background:repeating-linear-gradient(0deg,transparent 0 13mm,var(--accent-tint) 13mm 13.6mm),repeating-linear-gradient(90deg,transparent 0 13mm,var(--accent-tint) 13mm 13.6mm),radial-gradient(120% 90% at 60% 34%,var(--accent-wash),var(--paper))}
.fb__cities{position:absolute;left:0;top:0;width:78mm;height:100%;padding:12mm 9mm;display:flex;flex-direction:column;justify-content:space-between;gap:4mm;background:linear-gradient(90deg,var(--paper) 72%,transparent)}
.city .lab{display:flex;align-items:center;gap:2mm;font:400 13px/1 var(--display);text-transform:uppercase;color:var(--accent-ink);letter-spacing:.03em}
.city .lab .pin{width:3.6mm;height:4.6mm;flex:none;background:var(--accent);-webkit-mask:${PIN_MASK};mask:${PIN_MASK}}
.city h3{font:800 13px/1.05 var(--body);text-transform:uppercase;color:var(--ink);letter-spacing:.02em;margin:1.5mm 0 1mm}
.city p{font:400 10.5px/1.4 var(--body);color:var(--muted)}
.city .acts{font:600 10.5px/1.4 var(--body);color:var(--ink);margin-top:1mm}
.city .acts b{color:var(--accent-ink)}

/* ============ SECTION PAGE (flexible) ============ */
.secp{grid-template-rows:auto 1fr}
.secp__head{background:var(--accent);color:var(--on-accent);padding:12mm 15mm}
.secp__head h2{color:var(--on-accent);margin:0}
.secp__body{background:var(--paper);color:var(--ink);padding:12mm 15mm}
.secp__body p{font-size:13px;line-height:1.66;max-width:160mm}
.secp__cards{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6mm}
.secp__cards figure{position:relative;margin:0;height:54mm;border-radius:0;overflow:hidden;background:var(--accent-deep)}
.secp__cards img{width:100%;height:100%;object-fit:cover}
.secp__cards figcaption{position:absolute;left:0;right:0;bottom:0;padding:14mm 9px 8px;color:#fff;font:800 12px/1.2 var(--body);text-transform:uppercase;letter-spacing:.03em;background:linear-gradient(0deg,rgba(0,0,0,.8),transparent)}
.secp__cards figcaption small{display:block;font:400 10px/1.3 var(--body);text-transform:none;letter-spacing:0;opacity:.88;margin-top:1mm}

/* ---- SECTION FLOW: stacked, self-contained section blocks, paginated by real
   measured height so ARBITRARY extra sections pack tight, split across pages, and
   never clip or strand whitespace. One .secp-flow page holds 1..n .sblock units. */
.secp-flow{display:flex;flex-direction:column;justify-content:flex-start;gap:9mm;background:var(--paper);overflow:hidden}
.secp-flow.secp-flow--over{height:auto;min-height:297mm;overflow:visible}
/* Residual slack on a sparse section page is closed with a full-bleed DESTINATION
   PHOTO (preferred — the page gains real imagery, never a flat colour box) or, when
   no photo is available, a restrained centred colophon on paper. Both grow (flex) to
   absorb leftover height; a small remainder simply reads as a clean editorial margin. */
.secp-photo{flex:1 1 auto;min-height:0;position:relative;overflow:hidden;background:var(--accent-deep)}
.secp-photo img{width:100%;height:100%;object-fit:cover;display:block;filter:saturate(1.02) contrast(1.02)}
.secp-photo__cap{position:absolute;left:0;right:0;bottom:0;padding:18mm 15mm 9mm;color:#fff;background:linear-gradient(0deg,rgba(0,0,0,.6),transparent);font:700 12px/1.25 var(--body);text-transform:uppercase;letter-spacing:.06em}
.secp-colo{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4mm;text-align:center}
.secp-colo__rule{width:22mm;border-top:1.4px solid var(--accent)}
.secp-colo__mk{font:800 14px/1.1 var(--display);text-transform:uppercase;letter-spacing:.06em;color:var(--ink);opacity:.55}
.sblock{display:flex;flex-direction:column;flex:0 0 auto}
.sblock__head{background:var(--accent);color:var(--on-accent);padding:10mm 15mm 8mm}
/* A header band reserves space BELOW the brand logo (--hr scales with the logo size,
   set per-render; falls back to the legacy fixed value for the small auto mark). */
.sblock__head.has-mark{padding-top:var(--hr,16mm)}
.sblock__head .kick{color:var(--on-accent);opacity:.92}
.sblock__head h2{color:var(--on-accent);margin:0}
.sblock__head .cont-tag{opacity:.7;font-size:.78em;font-style:italic}
.sblock__body{background:var(--paper);color:var(--ink);padding:9mm 15mm}
.sblock__body p{font-size:13px;line-height:1.66;max-width:170mm}
.sblock__body p+.check{margin-top:4mm}
/* Many bullets read as a stranded narrow column on a wide field — flow them into two
   balanced columns so the content USES the page width (matches the logistics grid). */
.sblock__body .check.cols2{columns:2;column-gap:16mm;max-width:none}
.sblock__body .check.cols2 li{break-inside:avoid;-webkit-column-break-inside:avoid}
/* The .kv default paints values for a DARK band (--on-ink); on the paper section
   body that would be invisible — repaint for the light surface. */
.sblock__body .kv .v{color:var(--ink)}

/* ============ LOGISTICS PAGE ============ */
.log{grid-template-columns:1fr 53mm;grid-template-rows:1fr auto}
.log__col{grid-column:1;grid-row:1;display:flex;flex-direction:column;min-height:0}
.log__photo{grid-column:2;grid-row:1;position:relative;overflow:hidden;background:var(--accent-deep)}
.log__photo img{width:100%;height:100%;object-fit:cover}
.log__band-accent{background:var(--accent);color:var(--on-accent);padding:11mm 14mm}
/* When a left running mark sits in this band's top-left corner, drop the header
   content below it so the bigger logo never overprints the kicker/heading. */
.log__band-accent.has-mark{padding-top:var(--hr,17.5mm)}
.log__band-accent h2{color:var(--on-accent);margin:0}
.log__band-accent p{font-size:12px;line-height:1.55;opacity:.96;margin-top:2mm;max-width:110mm}
.log__incl{background:var(--band-ink);color:var(--on-ink);padding:11mm 14mm}
.log__incl h2{color:var(--on-ink)}
.kv{display:grid;grid-template-columns:38mm 1fr;gap:4mm 9mm;align-items:start}
.kv .k{color:var(--accent-ink);font:700 10.5px/1.3 var(--body);text-transform:uppercase;letter-spacing:.06em}
/* The inclusions grid sits on the DARK neutral band — repaint labels to read there. */
.log__incl .kv .k{color:var(--accent-on-ink)}
.kv .v{color:var(--on-ink);font:400 11.5px/1.42 var(--body)}
/* Natural height (NOT flex:1/overflow:hidden — that squeezed + clipped the table when
   the page was full). Pagination keeps it on a page where it fits in full. */
.log__price{background:var(--paper);color:var(--ink);padding:11mm 14mm}
.log__price.has-mark{padding-top:var(--hr,17.5mm)}
.log__fill{flex:1;background:var(--accent)}
/* preferred column filler when there's no pricing table: a destination photo, not a flat box */
.log__fillphoto{flex:1;min-height:0;overflow:hidden;background:var(--accent-deep)}
.log__fillphoto img{width:100%;height:100%;object-fit:cover;display:block;filter:saturate(1.02) contrast(1.02)}
table.price{width:100%;border-collapse:collapse;border:2px solid var(--accent)}
table.price th{background:var(--accent);color:var(--on-accent);text-align:left;padding:3.4mm 5mm;font:700 10.5px/1 var(--body);letter-spacing:.05em;text-transform:uppercase}
table.price td{padding:3.4mm 5mm;border-top:1px solid var(--accent-tint);font-size:12px;vertical-align:top}
table.price tr.em td{font-family:var(--display);font-weight:400;font-size:14px}
table.price td.amt{white-space:nowrap}
.pnote{font:400 10.5px/1.45 var(--muted);margin-top:3mm}
.log__cta{background:var(--band-ink);color:var(--on-ink);padding:11mm 14mm;display:flex;gap:9mm;align-items:flex-start}
.log__cta .qr{background:#fff;padding:2mm;flex:none}
.log__cta .qr img{width:27mm;height:27mm;display:block}
.log__cta .cta-h{font:400 19px/1.05 var(--display);text-transform:uppercase;color:var(--on-ink)}
/* The CTA is the most important line on the page — render it in the high-contrast
   on-ink colour (white on the dark band) rather than a muted accent tint. */
.log__cta .cta-h em{color:var(--on-ink);font-style:normal}
.check{list-style:none;margin-top:3mm}
.check li{position:relative;padding:0 0 2.6mm 8mm;font:400 11.5px/1.35 var(--body)}
.check li::before{content:"";position:absolute;left:0;top:.5mm;width:4.4mm;height:4.4mm;background:var(--accent);-webkit-mask:${CHECK_MASK};mask:${CHECK_MASK}}

/* ============ FOOTER ACCENT BAND (last page) ============ */
.foot{grid-column:1/-1;grid-row:2;background:var(--accent);color:var(--on-accent);display:flex;justify-content:space-between;align-items:center;padding:7mm 15mm;min-height:23mm}
.foot .lines{font:500 11.5px/1.7 var(--body)}
.foot .soc{display:flex;gap:5mm;align-items:center}
.foot .soc img{width:6mm;height:6mm}
`;

// ---- banded page builders ----
interface BandedAssets {
  hero: string;
  photos: string[];
  secUrls: string[][];
  /**
   * Spare destination-scenery photos reserved for FILLING residual space on sparse
   * pages (a sparse section page is closed with a full-bleed image rather than a flat
   * brand box). Generic — derived from the route/title, so it adapts to any trip.
   * UNIQUE: every entry differs from the cover/rail/section photos and from each other.
   */
  fillers: string[];
  /** Cursor into `fillers` — each fill site consumes the next one so a filler photo is
   *  never shown twice across the whole brochure. */
  fillCursor: { i: number };
  /**
   * Geocoded city points (+ optional resolved country, for the 3D silhouette).
   * `points[i].name` is the SAME key the composer used (place.geo || place.name), so map
   * pages match each place card to its projected pin. The 2D basemap needs only points;
   * the 3D silhouette additionally needs `country`. null → no usable geocoding.
   */
  geo: {
    country: Feat | null;
    points: LL[];
    accent: string;
    accentDeep: string;
    onAccent: string;
  } | null;
  /** Raster route-map URL (fallback when the country tile can't be built). */
  map: string;
  qr: string;
  onAccentHex: string;
}

function bandedCover(c: BrochureContent, a: BandedAssets): string {
  const heroImg = a.hero ? `<img class="hero" src="${esc(a.hero)}" alt="">` : '';

  // Uploaded brand logo (optional). Two source modes:
  //  • CUSTOM (visual placer) → the user dragged + sized the logo anywhere on the
  //    cover. We honour those exact coordinates with a free overlay and suppress
  //    every prompt-driven cover mark. The cover is a fixed photo composition, so a
  //    logo placed anywhere over it is collision-safe by construction.
  //  • AUTO (prompt enum) → top-left/top-right own a masthead corner; cover/cover-
  //    only/every-page/footer get a prominent CENTRED mark on the disc.
  // A frosted plate is the DEFAULT backing (the engine can't know the logo's own
  // luminance, so a light/thin logo must never vanish on the photo/disc); `.bare`
  // only when the brand explicitly flags a light background (onDark === false).
  const brand = c.__brand;
  const logo = brand?.logoUrl || '';
  const placement = brand?.placement || 'cover';
  const plate = brand?.onDark === false ? ' bare' : '';
  const customActive = !!brand?.custom; // when set, the prompt enum is fully ignored
  const fc = brand?.custom?.cover || null; // free cover placement (may be null = no cover logo)
  // Auto-path cover marks only when there is NO custom placement.
  const corner = !customActive && !!logo && (placement === 'top-left' || placement === 'top-right');
  const cornerSide: 'left' | 'right' = placement === 'top-right' ? 'right' : 'left';

  // Masthead row: the logo replaces the text on its chosen side; the other side
  // keeps its text. When the logo is centred (non-corner placements) both text
  // marks stay as-is.
  const leftText = esc(c.topLeft || c.agencyName || '');
  const rightText = esc(c.topRight || [c.agencyName ? '' : '', c.year].filter(Boolean).join(' · ') || c.year || '');
  const cornerLogo = `<span class="mlogo${plate}"><img src="${esc(logo)}" alt=""></span>`;
  // When any cover logo overlaps the masthead, the text yields beside it.
  const ko = combinedMastheadKeepout(brand, 16);
  let leftSlot: string;
  let rightSlot: string;
  if (corner) {
    leftSlot = cornerSide === 'left' ? cornerLogo : `<span>${leftText}</span>`;
    rightSlot = cornerSide === 'right' ? cornerLogo : `<span>${rightText}</span>`;
  } else {
    leftSlot = `<span${ko ? mhSlotStyle(ko.left) : ''}>${!ko || ko.left >= MH_MIN ? leftText : ''}</span>`;
    rightSlot = `<span${ko ? mhSlotStyle(ko.right) : ''}>${!ko || ko.right >= MH_MIN ? rightText : ''}</span>`;
  }
  const mark = `<div class="mark">${leftSlot}${rightSlot}</div>`;

  // Centred prominent mark only for AUTO non-corner placements.
  const brandmark = !customActive && logo && !corner ? `<div class="brandmark${plate}"><img src="${esc(logo)}" alt=""></div>` : '';
  // Free overlay for a CUSTOM cover placement: centred on (x,y) at the chosen width.
  // x/y/scale are server-clamped numbers — safe to interpolate into the inline style.
  const freeLogo =
    fc && logo
      ? `<div class="freelogo${plate}" style="left:${round1(clampN(fc.x, 0, 1) * 100)}%;top:${round1(
          clampN(fc.y, 0, 1) * 100,
        )}%;width:${round1(clampN(fc.scale, 0.06, 0.6) * 100)}%"><img src="${esc(logo)}" alt=""></div>`
      : '';

  // If a cover logo overlaps the main lockup / bottom strip, add a subtle shield so
  // the text remains legible without radically changing the photo composition.
  const lockShield = logoOverlapsRegion(brand, { x: 0, y: 100, w: 210, h: 100 }) ? 'background:rgba(0,0,0,0.42);padding:3mm 5mm;border-radius:2mm;' : '';
  const lock =
    `<div class="lock"${lockShield ? ` style="${lockShield}"` : ''}>` +
    (c.preTitle ? `<div class="pre">${esc(c.preTitle)}</div>` : '') +
    `<h1>${esc(c.title)}</h1>` +
    (c.subtitle || c.tagline ? `<div class="sub">${esc(c.subtitle || c.tagline)}</div>` : '') +
    (c.routeLine ? `<div class="route">${esc(c.routeLine)}</div>` : '') +
    `</div>`;
  const agencyShield = logoOverlapsRegion(brand, { x: 17, y: 250, w: 80, h: 35 }) ? 'background:rgba(0,0,0,0.42);padding:2mm 3mm;border-radius:2mm;' : '';
  const agency =
    c.agencyName || c.agencyLine
      ? `<div class="agency"${agencyShield ? ` style="${agencyShield}"` : ''}>${c.agencyName ? `<b>${esc(c.agencyName)}</b>` : ''}${esc(c.agencyLine || '')}</div>`
      : '';
  const pillShield = logoOverlapsRegion(brand, { x: 113, y: 250, w: 80, h: 35 }) ? 'background:rgba(0,0,0,0.42);padding:2mm 3mm;border-radius:2mm;' : '';
  const pill = c.badge ? `<div class="pill"${pillShield ? ` style="${pillShield}"` : ''}>${esc(c.badge)}</div>` : '';
  return `<section class="page cover">${heroImg}<div class="veil"></div><div class="disc"></div>${mark}${brandmark}${freeLogo}${coverLogosHtml(brand, 'freelogo')}${lock}${agency}${pill}</section>`;
}

/**
 * The effective interior running-mark CORNER, or null for none. The single source
 * of truth shared by both families. A custom (visual-placer) interior placement
 * WINS outright; otherwise it's derived from the prompt-parsed `placement` enum
 * exactly as before (cover/cover-only → no interior mark; every-page/footer/
 * top-left → top-left; top-right → top-right). Returns null when there is no logo.
 */
function runMarkCorner(c: BrochureContent): LogoCorner | null {
  const b = c.__brand;
  // The interior logo BAND drives the reserve as a top/bottom-centre mark (it doesn't
  // need the primary logo — its logos come from interiorLogos.items).
  if (b?.interiorLogos?.items?.length) return b.interiorLogos.band === 'bottom' ? 'bottom-center' : 'top-center';
  if (!b?.logoUrl) return null;
  if (b.custom) return b.custom.interior ? b.custom.interior.corner : null;
  const p = b.placement || 'cover';
  if (p === 'top-right') return 'top-right';
  if (p === 'every-page' || p === 'footer' || p === 'top-left') return 'top-left';
  return null; // cover / cover-only → no interior mark
}

/**
 * Subtle per-page running mark for the banded family. Absolute + zero flow height
 * so it never disturbs the page's CSS grid, never adds a page and never clips.
 * Corner + side come from `runMarkCorner` (prompt enum OR custom placer); a custom
 * size is bounded to a safe corner footprint. A frosted plate keeps it legible
 * over any band/photo. Returns '' when there is no interior mark.
 */
function wantsBandedRunMark(c: BrochureContent): boolean {
  return runMarkCorner(c) !== null;
}

function bandedRunMark(c: BrochureContent): string {
  const brand = c.__brand;
  // Multi-logo interior BAND wins over the single mark when present (header only — banded
  // is full-bleed, so a bottom band is clamped to the header by bandedSafeCorner inside).
  if (brand?.interiorLogos?.items?.length) return interiorLogoBandHtml(c, 'banded');
  const logo = brand?.logoUrl;
  const corner = bandedSafeCorner(runMarkCorner(c)); // banded → top-left/top-right only
  if (!logo || !corner) return '';
  const side = markSide(corner);
  const vert = corner.startsWith('bottom') ? ' bottom' : '';
  // Frosted plate by default so the mark is legible over photo rails, accent and
  // ink bands alike; opt out only when the brand flags a light background.
  const plate = brand?.onDark === false ? ' bare' : '';
  const cust = brand?.custom?.interior;
  if (cust) {
    // A running mark is HEIGHT-driven (like the auto mark) so the corner plate stays
    // snug. The height is clamped per zone (see customMarkH); the page content yields
    // to it (map labels move, editorial reserves a strip) so it's collision-proof.
    return `<div class="runmark ${side}${vert} custom${plate}"><img src="${esc(logo)}" alt="" style="height:${customMarkH(cust.scale, corner, 'banded')}mm"></div>`;
  }
  return `<div class="runmark ${side}${vert}${plate}"><img src="${esc(logo)}" alt=""></div>`;
}

/** Horizontal anchor class for a mark corner: left | right | center. */
function markSide(corner: LogoCorner): 'left' | 'right' | 'center' {
  return corner.endsWith('left') ? 'left' : corner.endsWith('right') ? 'right' : 'center';
}

/**
 * Banded interior marks live in the TOP header (left / centre / right) — the page's
 * section header band reserves space below the logo (scaled `--hr`, see `has-mark`),
 * and the map page relocates its route eyebrow around it. A BOTTOM zone would collide
 * with the full-bleed footer/CTA (no margin to reserve), so it's clamped up to the
 * matching top position. Editorial supports all six (it reflows — composeEditorialPages).
 */
function bandedSafeCorner(corner: LogoCorner | null): LogoCorner | null {
  if (!corner) return null;
  if (corner.startsWith('top')) return corner; // top-left / top-center / top-right kept
  return corner.endsWith('left') ? 'top-left' : corner.endsWith('right') ? 'top-right' : 'top-center';
}

/**
 * Map the placer's interior size slider (a 0.06–0.30 fraction) to a zone-SAFE mark
 * HEIGHT in mm. There's more room where there's no heading: BOTTOM edges and the
 * TOP-CENTRE (clear of the left-aligned kicker) get more height; the TOP corners stay
 * shorter so they clear the band/section heading. Shared by both families. With the
 * page-content keep-out (map labels move, editorial reserves a strip) the mark can
 * grow to these sizes and still never overprint content.
 */
function customMarkH(scale: number, corner: LogoCorner, family: 'banded' | 'editorial'): number {
  const top = corner.startsWith('top');
  const center = corner.endsWith('center');
  // EDITORIAL reserves a strip for the mark (composeEditorialPages), so it can grow
  // large. BANDED has no reserve (fixed-grid pages), so its marks stay within the
  // corner margins. Either way the slider (0.06–0.30) maps linearly to [minH, maxH].
  // TOP positions are a header (logo big, content reserves below it); editorial can
  // go large (it reflows), banded stays moderate (fixed grids can't reflow). BOTTOM
  // stays a modest footer mark.
  const maxH =
    family === 'editorial'
      ? top
        ? center
          ? 30
          : 26
        : 20 // editorial: top-corner 26 · top-centre 30 · bottom 20
      : top
        ? center
          ? 24
          : 22
        : 13; // banded: top-corner 22 · top-centre 24 · bottom 13 (header reserve scales with it)
  const minH = 9;
  const t = clampN((scale - 0.06) / (0.3 - 0.06), 0, 1);
  return clampN(round1(minH + t * (maxH - minH)), minH, maxH);
}

/**
 * When a CUSTOM cover logo sits over the masthead band, work out how much room (mm)
 * the left/right text slots have BESIDE the logo, so the agency wordmark wraps/yields
 * and never disappears behind the logo — the logo always wins. Returns null when the
 * logo is placed low enough to clear the masthead (text then unconstrained).
 */
function mastheadKeepout(
  fc: { x: number; y: number; scale: number },
  padMm: number,
): { left: number; right: number } | null {
  const W = 210;
  const halfH = fc.scale * W * 0.5; // square-ish height estimate (conservative)
  if (fc.y * 297 - halfH > 34) return null; // logo clears the top masthead band
  const gap = 5;
  return {
    left: round1(Math.max(0, (fc.x - fc.scale / 2) * W - padMm - gap)),
    right: round1(Math.max(0, W - padMm - (fc.x + fc.scale / 2) * W - gap)),
  };
}

/** All front-cover logo placements: the primary custom cover logo plus any extra
 *  coverLogos. Used to compute combined keepout for text regions. */
function allCoverLogoBoxes(brand: BrandKit | undefined): Array<{ x: number; y: number; scale: number }> {
  const out: Array<{ x: number; y: number; scale: number }> = [];
  if (brand?.custom?.cover && brand.logoUrl) out.push(brand.custom.cover);
  if (brand?.coverLogos) {
    for (const l of brand.coverLogos) {
      if (l?.url) out.push({ x: l.x, y: l.y, scale: l.scale });
    }
  }
  return out;
}

/** Combined masthead keepout across the primary cover logo AND any extra coverLogos.
 *  Returns left/right available widths (mm) for the masthead text slots, or null when
 *  no logo overlaps the top band. */
function combinedMastheadKeepout(
  brand: BrandKit | undefined,
  padMm: number,
): { left: number; right: number } | null {
  const logos = allCoverLogoBoxes(brand);
  if (!logos.length) return null;
  const W = 210;
  const H = 297;
  const bandBottom = 34;
  const gap = 5;
  let leftAvail = W;
  let rightAvail = W;
  let anyOverlap = false;
  for (const fc of logos) {
    const halfH = fc.scale * W * 0.5;
    const ty = fc.y * H - halfH;
    if (ty > bandBottom) continue;
    anyOverlap = true;
    const lx = (fc.x - fc.scale / 2) * W;
    const rx = (fc.x + fc.scale / 2) * W;
    leftAvail = Math.min(leftAvail, lx - padMm - gap);
    rightAvail = Math.min(rightAvail, W - rx - padMm - gap);
  }
  if (!anyOverlap) return null;
  return {
    left: round1(Math.max(0, leftAvail)),
    right: round1(Math.max(0, rightAvail)),
  };
}

/** True when any cover logo overlaps a rectangular region (mm coordinates). */
function logoOverlapsRegion(
  brand: BrandKit | undefined,
  region: { x: number; y: number; w: number; h: number },
): boolean {
  const logos = allCoverLogoBoxes(brand);
  if (!logos.length) return false;
  const W = 210;
  const H = 297;
  const rx2 = region.x + region.w;
  const ry2 = region.y + region.h;
  for (const fc of logos) {
    const lw = fc.scale * W;
    const lh = lw;
    const lx = fc.x * W - lw / 2;
    const rx = lx + lw;
    const ty = fc.y * H - lh / 2;
    const by = ty + lh;
    if (rx > region.x && lx < rx2 && by > region.y && ty < ry2) return true;
  }
  return false;
}
const MH_MIN = 14; // below this much side-room (mm) the slot text is dropped, not squeezed
const mhSlotStyle = (avail: number) => ` style="max-width:${avail}mm;white-space:normal;line-height:1.25"`;

// ---- Itinerary (.exp timeline) measure-and-flow packing ---------------------
// The .exp page is a fixed-height full-bleed grid (rail + accent why-band + paper
// timeline + close stat). Its timeline band is `overflow:hidden`, so a blind
// count cap (the old `balancedChunk(items, 11)`) clipped when day rows ran long
// and looked sparse when they ran short. We now MEASURE each day row's real mm
// height (headless Chrome, same path the banded sections use) and pack rows so a
// page can never exceed the band — clipping is impossible, the day-count adapts
// to the content, and the .exp LOOK is unchanged (same render body below).
const EXP_PAGE = 297; // full-bleed banded page height (mm)
const EXP_WHY = 60; // intro accent band reserved on page 1 (generous → bias to spill)
const EXP_CLOSE = 54; // close stat band reserved on the LAST page
const EXP_LHEAD = 24; // .exp__list kicker + h2 header (mm)
const EXP_LIST_PAD = 24; // .exp__list vertical padding (12mm top + 12mm bottom)
const EXP_ROW_GAP = 5.5; // .tl li padding-bottom — inter-row spacing (mm)
const EXP_SAFETY = 6; // sub-pixel cushion → always bias toward an extra page, never a clip

/** Conservative day-row height (mm) when the headless measurer is unavailable.
 *  Over-estimates → fewer rows per page → spill, never clip. */
function estExpDayHeight(it: { t: string; d: string }): number {
  const titleLines = Math.max(1, Math.ceil((it.t?.length || 0) / 38));
  const descLines = it.d ? Math.ceil(it.d.length / 52) : 0;
  return titleLines * 5.4 + descLines * 4.4 + 3;
}

/** Probe doc: each day row rendered inside the timeline at its real column width
 *  (.exp__list content = 141mm column − 30mm padding = 111mm) so measured heights
 *  match the final render. Tagged `data-ed-id` for the family-agnostic measurer. */
function buildExperienceMeasuringHtml(
  items: { t: string; d: string }[],
  tpl: BrochureTemplate,
  accent: string,
  accent2?: string,
): string {
  const vars = resolveBandedVars(tpl, accent, accent2);
  const probeCss = `.bd-probe{margin:0;padding:0;position:relative}`;
  const body = items
    .map(
      (it, i) =>
        `<div class="bd-probe" data-ed-id="exp-day-${i}" style="width:111mm"><ol class="tl"><li>` +
        `<div class="t">${esc(it.t)}</div>${it.d ? `<div class="d">${esc(it.d)}</div>` : ''}</li></ol></div>`,
    )
    .join('');
  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">${fontsLinkBanded(tpl.fonts.display, tpl.fonts.body, tpl.coverFont)}` +
    `<style>${vars}${BANDED_CSS}${tpl.css}${probeCss}</style></head><body>${body}</body></html>`
  );
}

/** Usable timeline height (mm) on a given .exp page — page 1 reserves the why band,
 *  the last page reserves the close stat band. */
function expAvail(isFirst: boolean, isLast: boolean, hasIntro: boolean, hasStat: boolean, listPadExtra = 0): number {
  return (
    EXP_PAGE -
    (isFirst && hasIntro ? EXP_WHY : 0) -
    (isLast && hasStat ? EXP_CLOSE : 0) -
    EXP_LHEAD -
    EXP_LIST_PAD -
    listPadExtra -
    EXP_SAFETY
  );
}

/** Greedy-pack day rows (by measured mm) into the minimum number of .exp pages that
 *  never overflow → the page COUNT is the true content-driven minimum. */
function greedyPackExp(dayH: number[], hasIntro: boolean, hasStat: boolean, listPadExtra = 0): number[][] {
  // Pass 1 — pack assuming no page is the last (close handled in pass 2).
  const pages: number[][] = [];
  let cur: number[] = [];
  let used = 0;
  for (let i = 0; i < dayH.length; i++) {
    const avail = expAvail(pages.length === 0, false, hasIntro, hasStat, listPadExtra);
    if (cur.length && used + dayH[i]! > avail) {
      pages.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(i);
    used += dayH[i]!;
  }
  if (cur.length) pages.push(cur);
  // Pass 2 — the real last page must also fit the close band; pop trailing rows that
  // no longer fit onto a fresh final page (which then carries the close instead).
  if (hasStat && pages.length) {
    for (let guard = 0; guard <= dayH.length; guard++) {
      const li = pages.length - 1;
      const avail = expAvail(li === 0, true, hasIntro, hasStat, listPadExtra);
      const u = pages[li]!.reduce((s, idx) => s + dayH[idx]!, 0);
      if (u <= avail || pages[li]!.length <= 1) break;
      pages.push([pages[li]!.pop()!]);
    }
  }
  return pages.length ? pages : [[]];
}

/** Pack day rows into .exp pages. Greedy fixes the MINIMUM page count (never clips);
 *  then we even out the distribution across that same count so a lone-orphan tail
 *  (e.g. 10 days → 9+1) becomes a balanced 5+5 — UNLESS a balanced page would
 *  overflow, in which case we keep the safe greedy split. Best look, never a clip. */
function packExperienceDays(
  dayH: number[],
  hasIntro: boolean,
  hasStat: boolean,
  listPadExtra = 0,
): { pages: number[][]; closeOnLast: boolean } {
  // Pack days by REAL height but WITHOUT reserving the close stat band. The close band
  // is decorative — it must never push a day onto an extra page (that turned 8 days
  // into a wasteful 4+4 with both pages half-empty). We decide the close placement
  // AFTER pagination: it renders only if it genuinely fits the last page's leftover.
  const greedy = greedyPackExp(dayH, hasIntro, false, listPadExtra);
  let pages = greedy;

  if (greedy.length > 1) {
    // Even out the day counts across the same page count so a lone-orphan tail (e.g.
    // 10 → 9+1) becomes a balanced 5+5 — unless a balanced page would overflow, in
    // which case keep the safe greedy split.
    const n = dayH.length;
    const P = greedy.length;
    const base = Math.floor(n / P);
    const extra = n % P;
    const cand: number[][] = [];
    let k = 0;
    for (let p = 0; p < P; p++) {
      const cnt = base + (p < extra ? 1 : 0);
      const g: number[] = [];
      for (let j = 0; j < cnt; j++) g.push(k++);
      cand.push(g);
    }
    const fits = cand.every(
      (grp, pi) => grp.reduce((s, idx) => s + dayH[idx]!, 0) <= expAvail(pi === 0, false, hasIntro, false, listPadExtra),
    );
    pages = fits ? cand : greedy;
  }

  // Close band renders on the last page ONLY if it fits there (days + close ≤ usable);
  // otherwise it's dropped so the days stay on the minimum number of pages.
  let closeOnLast = false;
  if (hasStat && pages.length) {
    const last = pages[pages.length - 1]!;
    const load = last.reduce((s, idx) => s + dayH[idx]!, 0);
    closeOnLast = load <= expAvail(pages.length === 1, true, hasIntro, true, listPadExtra);
  }
  return { pages, closeOnLast };
}

async function experiencePages(
  c: BrochureContent,
  a: BandedAssets,
  tpl: BrochureTemplate,
  accent: string,
  accent2?: string,
  measure?: EdMeasureFn,
): Promise<string[]> {
  const days = c.itinerary?.days ?? [];
  const hcards = c.highlights?.cards ?? [];
  const baseItems: { t: string; d: string }[] = days.length
    ? days.map((d) => ({ t: d.title, d: d.text }))
    : hcards.map((h) => ({ t: h.label, d: h.caption || '' }));
  // A tiny itinerary (1–2 days, e.g. a single-day multi-stop trip) would leave the
  // elastic timeline stretched over a near-empty page — fold the highlight stops in
  // as extra timeline entries so the day(s) read full and intentional, never bare.
  const items: { t: string; d: string }[] =
    days.length && days.length <= 2 && hcards.length
      ? [...baseItems, ...hcards.map((h) => ({ t: h.label, d: h.caption || '' }))]
      : baseItems;
  const hasIntro = !!(c.intro && (c.intro.heading || c.intro.body));
  if (!items.length && !hasIntro && !hcards.length) return [];

  const listKick = c.itinerary?.kicker || c.highlights?.kicker || '';
  const listTitle = c.itinerary?.heading || c.highlights?.heading || 'Highlights';

  const stat = c.highlights?.stat;

  // Interior header mark determines how much top padding we must reserve so headers
  // (why band + experience list) don't slide under the logo band. A top-LEFT mark sits
  // over the left photo rail, so the right-column copy needs no extra reserve.
  const corner = bandedSafeCorner(runMarkCorner(c));
  const headerReserve = bandedHeaderReserve(c) ?? 16;
  const listHasMark = !!corner && corner !== 'top-left';
  const listPadExtra = listHasMark ? Math.max(0, headerReserve - 12) : 0;

  // Measure-and-flow: real day-row heights → height-driven pagination (never clips,
  // adapts the day-count). Estimate fallback when no measurer (spill, never clip).
  let chunks: { t: string; d: string }[][];
  let closeOnLast = !!stat; // when there are no measurable days, keep prior behaviour
  if (items.length) {
    let measured: Record<string, number> | null = null;
    if (measure) {
      try {
        measured = await measure(
          buildExperienceMeasuringHtml(items, tpl, accent, accent2),
          items.map((_, i) => `exp-day-${i}`),
        );
      } catch {
        measured = null;
      }
    }
    const dayH = items.map((it, i) => sanitizeMeasuredSec(measured?.[`exp-day-${i}`], estExpDayHeight(it)) + EXP_ROW_GAP);
    const packed = packExperienceDays(dayH, hasIntro, !!stat, listPadExtra);
    closeOnLast = packed.closeOnLast;
    chunks = packed.pages.map((g) => g.map((idx) => items[idx]!));
  } else {
    chunks = [[]];
  }
  // Close photo = the next UNIQUE filler (never the cover hero or a rail photo again);
  // only fall back to a spare highlight / hero if the pool is exhausted.
  const railCards = hcards.slice(0, 4);
  let closePhoto = a.fillers[a.fillCursor.i] || '';
  if (closePhoto) a.fillCursor.i++;
  else closePhoto = a.photos[railCards.length] || a.hero;

  // Build a fresh photo rail per page. Page 1 uses the assigned highlight photos;
  // continuation pages consume new filler images so the same 4 photos don't repeat.
  const buildRail = (idx: number): string => {
    if (railCards.length) {
      const railFigs = railCards
        .map((card, i) => {
          const src = idx === 0 ? a.photos[i] : a.fillers[a.fillCursor.i++] || '';
          return `<figure>${src ? `<img src="${esc(src)}" alt="">` : ''}<figcaption>${esc(card.label)}</figcaption></figure>`;
        })
        .join('');
      return `<div class="exp__rail">${railFigs}</div>`;
    }
    const src = idx === 0 ? a.hero : a.fillers[a.fillCursor.i++] || '';
    return `<div class="exp__rail"><figure>${src ? `<img src="${esc(src)}" alt="">` : ''}<figcaption>${esc(c.title)}</figcaption></figure></div>`;
  };

  return chunks.map((slice, idx) => {
    const first = idx === 0;
    const last = idx === chunks.length - 1;
    const whyMark = first && listHasMark;
    const why =
      first && hasIntro
        ? `<div class="exp__why${whyMark ? ' has-mark' : ''}">` +
          (c.intro!.kicker ? `<div class="kick">${esc(c.intro!.kicker)}</div>` : '') +
          (c.intro!.heading ? `<h2>${esc(c.intro!.heading)}</h2>` : '') +
          (c.intro!.body ? `<p>${esc(c.intro!.body)}</p>` : '') +
          `</div>`
        : '';
    const li = slice
      .map((it) => `<li><div class="t">${esc(it.t)}</div>${it.d ? `<div class="d">${esc(it.d)}</div>` : ''}</li>`)
      .join('');
    const listCls = listHasMark ? 'exp__list has-mark' : 'exp__list';
    const list =
      `<div class="${listCls}">` +
      (listKick ? `<div class="kick">${esc(listKick)}</div>` : '') +
      `<h2>${esc(listTitle)}</h2>` +
      (li ? `<ol class="tl">${li}</ol>` : '') +
      `</div>`;
    let close = '';
    if (last && stat && closeOnLast) {
      close =
        `<div class="exp__close">` +
        `<figure>${closePhoto ? `<img src="${esc(closePhoto)}" alt="">` : ''}</figure>` +
        `<div class="copy"><div class="big">${esc(stat.big)}</div>` +
        `<div class="ct"><b>${esc(stat.label)}</b>${c.tagline ? esc(c.tagline) : esc(c.subtitle || '')}</div></div>` +
        `</div>`;
    }
    return `<section class="page exp">${buildRail(idx)}<div class="exp__main">${why}${list}</div>${close}</section>`;
  });
}

function fallbackMapSvg(n: number): string {
  const k = Math.max(n, 2);
  const pts: [number, number][] = [];
  for (let i = 0; i < k; i++) {
    const x = 24 + ((i % 2 === 0 ? 0 : 18) + (i * (52 / (k - 1)))) * 0.7;
    const y = 22 + i * (96 / (k - 1));
    pts.push([Math.min(82, x), y]);
  }
  const poly = pts.map((p) => `${p[0]},${p[1]}`).join(' ');
  const circles = pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="2.6" fill="var(--accent)"/>`).join('');
  return `<svg viewBox="0 0 100 140" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%"><polyline points="${poly}" fill="none" stroke="var(--accent)" stroke-width="1.1" stroke-dasharray="2 5"/>${circles}</svg>`;
}

interface MapPlace {
  name: string;
  subtitle?: string;
  body?: string;
  activities?: string;
  geo?: string;
}

/** mm → px at 96dpi, so one SVG user unit == one CSS px == aligns with mm-positioned HTML. */
const PXMM = 3.7795;
const f1 = (v: number): string => v.toFixed(1);
const round1 = (v: number): number => Math.round(v * 10) / 10;
const clampN = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

// ---- Web Mercator (256-tile) — matches Geoapify so overlaid markers land accurately ----
const mercX = (lon: number): number => (lon + 180) / 360;
const mercY = (lat: number): number => {
  const s = Math.sin((clampN(lat, -85, 85) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const invMercY = (y: number): number => {
  const t = Math.exp((0.5 - y) * 4 * Math.PI);
  return (Math.asin((t - 1) / (t + 1)) * 180) / Math.PI;
};

/**
 * Estimate how many lines a string wraps to in a given width — deterministic, so we can
 * size the accent/ink bands at build time (Chrome can't measure for us). Errs slightly
 * TALL (never clips). avgCharW is the face's average advance as a fraction of font-size.
 */
function estLines(text: string, widthMm: number, fontPx: number, trackEm: number, avgCharW: number): number {
  const cpl = Math.max(1, Math.floor((widthMm * PXMM) / (fontPx * avgCharW * (1 + trackEm))));
  const byChars = Math.ceil((text?.length ?? 0) / cpl);
  const words = String(text || '').split(/\s+/).filter(Boolean);
  let line = 0,
    lines = 1;
  for (const w of words) {
    const wl = w.length + 1;
    if (line + wl > cpl && line > 0) {
      lines++;
      line = wl;
    } else line += wl;
  }
  return Math.max(1, byChars, lines);
}

interface MPt {
  name: string;
  p: MapPlace;
  px: number;
  py: number;
  tpx: number;
  tpy: number;
}

/**
 * Deterministic marker de-overlap: push any markers closer than R apart, a fixed number
 * of passes, clamping inside the map rect each pass so a nudged pin never lands in the
 * callout columns. Guarantees "Agra is never hidden" without any post-render measurement.
 */
function relaxMarkers(pts: MPt[], rect: Rect, R: number, passes: number, markerR: number): void {
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i]!,
          b = pts[j]!;
        let dx = b.px - a.px,
          dy = b.py - a.py;
        let dist = Math.hypot(dx, dy);
        if (dist < R) {
          if (dist < 0.5) {
            dx = 0;
            dy = 1;
            dist = 1;
          }
          const push = (R - dist) / 2,
            ux = dx / dist,
            uy = dy / dist;
          a.px -= ux * push;
          a.py -= uy * push;
          b.px += ux * push;
          b.py += uy * push;
        }
      }
    for (const q of pts) {
      q.px = clampN(q.px, rect.x + markerR, rect.x + rect.w - markerR);
      q.py = clampN(q.py, rect.y + markerR, rect.y + rect.h - markerR);
    }
  }
}

/**
 * 2D basemap (DEFAULT): a real geographic map (Geoapify Web-Mercator raster) framed to
 * the route, returned with a matching projector so the engine overlays its own markers /
 * name tags / leaders accurately. Works for ANY place — cities, regions, multi-country
 * trips — not just single bundled-polygon countries. null if no static-map key.
 */
function buildBasemap2d(
  mpts: { lon: number; lat: number }[],
  zone: Rect,
): { behind: string; project: (lon: number, lat: number) => [number, number] } | null {
  let mnX = Infinity,
    mxX = -Infinity,
    mnY = Infinity,
    mxY = -Infinity;
  for (const p of mpts) {
    const x = mercX(p.lon),
      y = mercY(p.lat);
    if (x < mnX) mnX = x;
    if (x > mxX) mxX = x;
    if (y < mnY) mnY = y;
    if (y > mxY) mxY = y;
  }
  let spanX = Math.max(mxX - mnX, 1e-4),
    spanY = Math.max(mxY - mnY, 1e-4);
  const pad = 0.22;
  mnX -= spanX * pad;
  mxX += spanX * pad;
  mnY -= spanY * pad;
  mxY += spanY * pad;
  spanX = mxX - mnX;
  spanY = mxY - mnY;
  const midX = (mnX + mxX) / 2,
    midY = (mnY + mxY) / 2;
  // aspect-match the Mercator frame to the zone so the raster fills it with no distortion
  const zoneAspect = zone.w / zone.h;
  if (spanX / spanY < zoneAspect) spanX = spanY * zoneAspect;
  else spanY = spanX / zoneAspect;
  const rasterW = clampN(Math.round(zone.w * 2), 400, 1500);
  const rasterH = Math.round(rasterW / zoneAspect);
  // zoom so rasterW px covers spanX of the normalized world; clamp for sane context
  let zoom = Math.log2(rasterW / (spanX * 256));
  zoom = clampN(zoom, 2.5, 12);
  const worldPx = 256 * Math.pow(2, zoom);
  const clon = midX * 360 - 180;
  const clat = invMercY(midY);
  const url = staticMapUrl({ center: { lon: clon, lat: clat }, zoom, width: rasterW, height: rasterH });
  if (!url) return null;
  const cxpx = midX * worldPx,
    cypx = midY * worldPx;
  const project = (lon: number, lat: number): [number, number] => {
    const xpx = mercX(lon) * worldPx - cxpx + rasterW / 2;
    const ypx = mercY(lat) * worldPx - cypx + rasterH / 2;
    return [zone.x + (xpx / rasterW) * zone.w, zone.y + (ypx / rasterH) * zone.h];
  };
  const rx = Math.min(zone.w, zone.h) * 0.035;
  const geoBox = `left:${f1(zone.x)}px;top:${f1(zone.y)}px;width:${f1(zone.w)}px;height:${f1(zone.h)}px;border-radius:${f1(rx)}px`;
  // No accent veil over the basemap — a coloured multiply layer tinted the whole map
  // (most visible with a saturated brand accent) and made it read murky. The map stays
  // CLEAR; the brand accent already shows through the route line, pins and city labels.
  const behind = `<img class="map__base" src="${esc(url)}" alt="Route map" style="${geoBox}">`;
  return { behind, project };
}

/**
 * 3D basemap (opt-in): the WHOLE bundled-polygon country silhouette at its natural size,
 * centred in the zone (NOT zoomed to the route — the user wants the country shown at
 * correct scale). The frame is the country bbox, lightly padded, then aspect-matched
 * (grow-only) to the zone purely to CENTRE it — so the binding axis fills and the other
 * is balanced. Returns SVG paths + a matching projector.
 */
function buildBasemap3d(
  country: Feat,
  zone: Rect,
  col: TileColors,
  clipId: string,
): { svgPrefix: string; project: (lon: number, lat: number) => [number, number] } | null {
  const cb = countryBbox(country);
  const padLon = (cb[2] - cb[0]) * 0.06,
    padLat = (cb[3] - cb[1]) * 0.06;
  let fMinLon = cb[0] - padLon,
    fMaxLon = cb[2] + padLon,
    fMinLat = cb[1] - padLat,
    fMaxLat = cb[3] + padLat;
  // aspect-match (grow-only) to the zone → centres the country at its natural proportions
  const kx = Math.cos((((fMinLat + fMaxLat) / 2) * Math.PI) / 180) || 1;
  const zoneAspect = zone.w / zone.h;
  const geoAspect = ((fMaxLon - fMinLon) * kx) / (fMaxLat - fMinLat);
  if (geoAspect < zoneAspect) {
    const ns = ((fMaxLat - fMinLat) * zoneAspect) / kx;
    const m = (fMinLon + fMaxLon) / 2;
    fMinLon = m - ns / 2;
    fMaxLon = m + ns / 2;
  } else {
    const ns = ((fMaxLon - fMinLon) * kx) / zoneAspect;
    const m = (fMinLat + fMaxLat) / 2;
    fMinLat = m - ns / 2;
    fMaxLat = m + ns / 2;
  }
  const render = renderCountryFramed(country, zone, { minLon: fMinLon, maxLon: fMaxLon, minLat: fMinLat, maxLat: fMaxLat }, col, clipId);
  if (!render) return null;
  return { svgPrefix: render.paths, project: render.project };
}

/**
 * Resolve the route's stops from ANY available signal, most-trusted first, so a map
 * renders whenever the brief implies a route — even when the composer under-fills the
 * structured `route` object (a common cause of a "missing" map). Order: explicit
 * `route.cities` → `route.places` (geo hints) → parse the `routeLine` ("A → B — C").
 * Splits only on ARROWS / dashes (never commas) so "City, Country" stays intact.
 */
function routeCities(c: BrochureContent): string[] {
  const clean = (xs: (string | undefined)[]) => xs.map((s) => (s ?? '').trim()).filter(Boolean);
  let cities = clean(c.route?.cities ?? []);
  if (cities.length < 2 && c.route?.places?.length) {
    cities = clean(c.route.places.map((p) => p.geo || p.name));
  }
  if (cities.length < 2 && c.routeLine) {
    cities = clean(c.routeLine.split(/\s*(?:→|⟶|➝|—|–|->|>)\s*|\s+-\s+/));
  }
  return cities;
}

/**
 * The map page: a real geographic 2D basemap (default) — or the 3D country silhouette
 * when the prompt asks for "3D" — framed to the route, with a marker at every city and
 * bent dotted leader lines from the side callout cards to their pins. The overlay SVG
 * and the HTML callout cards share ONE coordinate origin (the stage box), so leaders
 * land exactly on the pins for any place, shape or city count. A top KICKER strip fills
 * the header; the accent headline + ink closing bands are sized to their text.
 */
/**
 * Geocode a route's stops, REGION-CONSTRAINED for accuracy. Bare-name geocoding picks
 * the wrong global match for ambiguous town names (e.g. "Baga" → Bagà, Spain instead of
 * Baga, Goa). So: geocode once, resolve the destination country from the MEDIAN pin
 * (robust — one stop in the wrong country can't hijack it), then — only when a clear
 * majority of pins already sit in that country — RE-geocode the stragglers constrained
 * to its ISO code. A genuine multi-country itinerary (no single dominant country) is
 * left untouched. Used by BOTH families (banded 2D basemap + editorial 3D silhouette).
 */
async function geocodeRoute(keys: string[], limit = 8): Promise<{ points: LL[]; country: Feat | null }> {
  const slice = keys.slice(0, limit);
  const rough: (LL | null)[] = [];
  for (const key of slice) {
    let pt: LL | null = null;
    try {
      const g = await geocode(key);
      if (g) pt = { name: key, lon: g.lon, lat: g.lat };
    } catch {
      /* skip */
    }
    rough.push(pt);
    await new Promise((r) => setTimeout(r, 1100)); // honour Nominatim 1 req/s
  }
  const found = rough.filter((p): p is LL => !!p);
  if (found.length < 2) return { points: found, country: null };
  // Destination country from the MEDIAN pin — a single mis-geocoded stop can't hijack it.
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
  const mid: LL = { name: '_median', lon: med(found.map((p) => p.lon)), lat: med(found.map((p) => p.lat)) };
  const country = findCountry([mid], slice);
  if (!country?.i) return { points: found, country };
  // "Plausibly in-country" = inside the country's padded bbox (coarse 110m polygons miss
  // coastal towns, so a padded bbox is safer than strict polygon containment here).
  const [mnx, mny, mxx, mxy] = countryBbox(country);
  const px = (mxx - mnx) * 0.12 + 0.5;
  const py = (mxy - mny) * 0.12 + 0.5;
  const inCtry = (lon: number, lat: number) => lon >= mnx - px && lon <= mxx + px && lat >= mny - py && lat <= mxy + py;
  // Re-home stragglers ONLY when a clear majority of pins already sit in one country
  // (a genuine multi-country itinerary must NOT be force-collapsed into one country).
  const cluster = found.filter((p) => inCtry(p.lon, p.lat));
  if (cluster.length < Math.ceil(found.length / 2)) return { points: found, country };
  // A tight viewbox around the in-country CLUSTER, so an ambiguous town re-homes to the
  // right REGION — not merely the right country (there are several "Baga"s in India).
  let vmnx = Infinity,
    vmny = Infinity,
    vmxx = -Infinity,
    vmxy = -Infinity;
  for (const p of cluster) {
    vmnx = Math.min(vmnx, p.lon);
    vmxx = Math.max(vmxx, p.lon);
    vmny = Math.min(vmny, p.lat);
    vmxy = Math.max(vmxy, p.lat);
  }
  const PAD = 3; // degrees of slack around the cluster
  const vb: [number, number, number, number] = [vmnx - PAD, vmny - PAD, vmxx + PAD, vmxy + PAD];
  const inBox = (lon: number, lat: number) => lon >= vb[0] && lon <= vb[2] && lat >= vb[1] && lat <= vb[3];
  const refined: LL[] = [];
  for (let i = 0; i < slice.length; i++) {
    const r = rough[i] ?? null;
    if (r && inBox(r.lon, r.lat)) {
      refined.push(r);
      continue;
    }
    // Straggler → re-geocode bounded to the cluster region (right country + right area).
    let fixed: LL | null = null;
    try {
      const g = await geocode(slice[i]!, { countryCode: country.i, viewbox: vb, bounded: true });
      if (g && inBox(g.lon, g.lat)) fixed = { name: slice[i]!, lon: g.lon, lat: g.lat };
    } catch {
      /* skip */
    }
    await new Promise((r) => setTimeout(r, 1100));
    if (fixed) refined.push(fixed); // re-homed; else DROP it — a wrong-region pin is worse than none
  }
  return { points: refined.length >= 2 ? refined : found, country };
}

/**
 * Ensure every map stop carries SOME detail — the banded callout cards look empty with
 * bare names. When the composer under-fills route.places (only names / only cities), derive
 * a one-line body from the itinerary day that names the city. Deterministic, so the map page
 * always reads rich even when the model skips the per-place fields.
 */
function enrichPlaces(places: MapPlace[], c: BrochureContent): MapPlace[] {
  const days = c.itinerary?.days ?? [];
  if (!days.length) return places;
  return places.map((p) => {
    if (p.subtitle || p.body || p.activities) return p; // already detailed
    const nm = (p.name || '').toLowerCase().trim();
    if (!nm) return p;
    const day =
      days.find((d) => (d.title || '').toLowerCase().includes(nm)) ||
      days.find((d) => (d.text || '').toLowerCase().includes(nm));
    if (!day?.text) return p;
    const body = day.text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').slice(0, 220);
    return body ? { ...p, body } : p;
  });
}

function mapPages(c: BrochureContent, a: BandedAssets): string[] {
  let places: MapPlace[] = c.route?.places?.length
    ? c.route.places
    : (c.route?.cities ?? []).map((n) => ({ name: n.replace(/,.*$/, ''), geo: n }));
  // RELIABILITY: if the composer under-filled `route`, recover the stops from the
  // routeLine / itinerary so a requested map still renders (never silently dropped).
  if (places.length < 2) {
    const rc = routeCities(c);
    if (rc.length >= 2) places = rc.map((n) => ({ name: n.replace(/,.*$/, ''), geo: n }));
  }
  if (places.length < 2) return [];
  places = enrichPlaces(places, c); // never show bare-name pins — fill detail from the itinerary

  // The 3D map shows ONE country silhouette — plot only the destination stops that fall
  // inside it (drop a home/departure city in another country) and dedup repeated stops
  // on a round-trip, so the map shows just the locations, never an off-silhouette pin.
  if (c.__map3d && a.geo?.country) {
    const cb = countryBbox(a.geo.country);
    const pl = (cb[2] - cb[0]) * 0.15,
      pa = (cb[3] - cb[1]) * 0.15;
    const seen = new Set<string>();
    const filtered = places.filter((p) => {
      const ll = a.geo!.points.find((pt) => pt.name === (p.geo || p.name));
      if (!ll) return false;
      const k = (p.name || '').toLowerCase();
      if (seen.has(k)) return false;
      const ok = ll.lon >= cb[0] - pl && ll.lon <= cb[2] + pl && ll.lat >= cb[1] - pa && ll.lat <= cb[3] + pa;
      if (ok) seen.add(k);
      return ok;
    });
    if (filtered.length >= 2) places = filtered;
  }

  const headline = c.route?.headline || c.route?.heading || 'The Route';
  const closing = c.route?.closing || '';

  // Content-measured bands (same headline/closing across pages) so they never look
  // empty (Italy) or oversized (India). stageHmm stays an EXACT build-time number, so
  // the SVG viewBox + mm-positioned HTML stay aligned.
  let headFont = 26;
  for (const f of [34, 30, 26]) {
    if (estLines(headline, 180, f, 0, 0.56) <= 2) {
      headFont = f;
      break;
    }
  }
  const headLines = estLines(headline, 180, headFont, 0, 0.56);
  const headH = clampN(round1(3 + headLines * ((headFont * 1.03) / PXMM) + 3), 30, 58);
  const closeH = closing ? clampN(round1(5 + estLines(closing, 180, 12, 0.025, 0.52) * ((12 * 1.5) / PXMM) + 5), 18, 40) : 0;
  const stageHmm = round1(297 - headH - closeH);
  const bands =
    `<div class="map__headline" style="top:${stageHmm}mm;height:${headH}mm"><h2 style="font-size:${headFont}px">${esc(headline)}</h2></div>` +
    (closing ? `<div class="map__close" style="top:${round1(stageHmm + headH)}mm;height:${closeH}mm">${esc(closing)}</div>` : '');

  const want3d = !!c.__map3d;
  const chunks = balancedChunk(places, 5);
  // A TOP brand mark overlaps this page's top kicker. Give the LOGO PRIORITY and move
  // the route eyebrow ("Kochi → Alleppey") to the CLEAR side so it's never hidden:
  //  • mark top-RIGHT → eyebrow goes LEFT (drop the generic label);
  //  • mark top-LEFT  → drop the generic left label, eyebrow stays RIGHT;
  //  • top-centre / bottom / none → label left + eyebrow right, as usual.
  const mc = bandedSafeCorner(runMarkCorner(c));
  const markTopLeft = mc === 'top-left';
  const markTopRight = mc === 'top-right';
  // A full-width top-centre / band mark sits over the kicker; push the whole strip
  // down by the header reserve so the route text remains legible. Corner marks keep
  // the existing eyebrow-swap behaviour instead.
  const kickerMark = !!mc && !markTopLeft && !markTopRight;

  return chunks.map((slice, ci) => {
    // Top kicker strip — fills the header, on every page, deterministic text.
    const first = slice[0]?.name ?? '';
    const last = slice[slice.length - 1]?.name ?? '';
    const kickText = c.route?.kicker || (chunks.length > 1 ? `Part ${ci + 1} of ${chunks.length}` : 'The Route');
    const kk = `<span class="kk">${esc(kickText)}</span>`;
    const eye = first && last && first !== last ? `<span class="eye">${esc(first)} → ${esc(last)}</span>` : '<span></span>';
    const kickerCls = 'map__kicker' + (kickerMark ? ' has-mark' : '');
    const kicker = markTopRight
      ? `<div class="${kickerCls}">${eye}<span></span></div>` // eyebrow LEFT, clear of the right mark
      : markTopLeft
        ? `<div class="${kickerCls}"><span></span>${eye}</div>` // eyebrow RIGHT, clear of the left mark
        : `<div class="${kickerCls}">${kk}${eye}</div>`;

    // Match each place in this slice to its geocoded pin (by the same key the composer used).
    const pinFor = (p: MapPlace): LL | undefined => a.geo?.points.find((pt) => pt.name === (p.geo || p.name));
    const matched = (a.geo ? slice.map((p) => ({ p, ll: pinFor(p) })).filter((m) => m.ll) : []) as { p: MapPlace; ll: LL }[];

    const inner = matched.length >= 2 && a.geo ? annotatedMap(matched, a.geo, stageHmm, ci, want3d) : null;
    const body = inner ?? fallbackStage(slice, a);

    return `<section class="page map map--anno"><div class="map__stage geo" style="height:${stageHmm}mm">${kicker}${body}<div class="map__note">Map for representation only</div></div>${bands}</section>`;
  });
}

/**
 * The annotated map stage: a basemap (2D real map by default, 3D silhouette on request)
 * + coordinate-accurate markers, leader lines and (single-column only) name tags + the
 * side callout cards. Returns null if no basemap can be built (caller → fallbackStage).
 */
function annotatedMap(
  matched: { p: MapPlace; ll: LL }[],
  geo: NonNullable<BandedAssets['geo']>,
  stageHmm: number,
  ci: number,
  want3d: boolean,
): string | null {
  const { country, accent, accentDeep, onAccent } = geo;
  const W = 210 * PXMM;
  const Hpx = stageHmm * PXMM;

  // Column layout (mm): ≤3 cities → one left column + a wide map; else flank both sides.
  const both = matched.length > 3;
  const side = 5,
    colW = 52,
    gap = 6;
  const leftRight = side + colW;
  const rightX = 210 - side - colW;
  const zoneXmm = leftRight + gap;
  const zoneWmm = (both ? rightX - gap : 210 - side) - zoneXmm;
  // The map zone sits clearly BELOW the kicker strip (which ends ~15mm) with a 3mm gap,
  // plus a small bottom margin — so the map window never collides with the kicker rule.
  const zone: Rect = { x: zoneXmm * PXMM, y: 18 * PXMM, w: zoneWmm * PXMM, h: (stageHmm - 18 - 6) * PXMM };
  const col: TileColors = { accent, accentDeep, onAccent };
  const mpts = matched.map((m) => ({ lon: m.ll.lon, lat: m.ll.lat }));

  // Pick the basemap: 3D only if explicitly requested AND a country resolved; otherwise
  // the 2D real map (default). Each path degrades gracefully to the other.
  let behind = '';
  let svgPrefix = '';
  let project: ((lon: number, lat: number) => [number, number]) | null = null;
  if (want3d && country) {
    const r = buildBasemap3d(country, zone, col, String(ci));
    if (r) ({ svgPrefix, project } = r);
  }
  if (!project) {
    const r = buildBasemap2d(mpts, zone);
    if (r) ({ behind, project } = r);
  }
  if (!project && country) {
    const r = buildBasemap3d(country, zone, col, String(ci));
    if (r) ({ svgPrefix, project } = r);
  }
  if (!project) return null;

  const mode2d = behind !== '';
  // Marker / line / label palette: contrast a LIGHT real map (2D) vs the accent country (3D).
  const mk = mode2d
    ? { fill: accent, ring: '#ffffff', dot: '#ffffff', ringW: 1.6 }
    : { fill: onAccent, ring: accentDeep, dot: accent, ringW: 1.4 };
  const lineCore = mode2d ? accent : onAccent;
  const lineCasing = mode2d ? '#ffffff' : onAccent === '#ffffff' ? '#15151c' : '#ffffff';
  const labelCore = mode2d ? '#15151c' : onAccent;
  const labelCasing = mode2d ? '#ffffff' : lineCasing;

  // Project pins; keep TRUE positions for the route, PUSHED positions (de-overlapped) for
  // markers/leaders so a tight cluster never hides a city.
  const markerR = 5.4;
  const pts: MPt[] = matched.map((m) => {
    const [px, py] = project!(m.ll.lon, m.ll.lat);
    return { name: m.p.name, p: m.p, px, py, tpx: px, tpy: py };
  });
  relaxMarkers(pts, zone, 2.4 * markerR, 14, markerR);

  // Assign each card to a column by PUSHED pin x; rebalance by latitude if a side empties.
  const midX = zone.x + zone.w / 2;
  const leftCol = both ? pts.filter((q) => q.px <= midX) : pts.slice();
  const rightCol = both ? pts.filter((q) => q.px > midX) : [];
  if (both && (leftCol.length === 0 || rightCol.length === 0)) {
    const all = pts.slice().sort((u, v) => u.py - v.py);
    leftCol.length = 0;
    rightCol.length = 0;
    all.forEach((q, i) => (i % 2 === 0 ? leftCol : rightCol).push(q));
  }
  leftCol.sort((u, v) => u.py - v.py);
  rightCol.sort((u, v) => u.py - v.py);

  // Lay out the callout cards in vertical slots below the kicker; record leader anchors.
  const topMm = 18,
    botMm = stageHmm - 6;
  const usable = botMm - topMm;
  const cards: string[] = [];
  const anchors: { ax: number; ay: number; q: MPt }[] = [];
  const layoutCol = (column: MPt[], x: number, right: boolean) => {
    const k = column.length;
    if (!k) return;
    const slot = usable / k;
    column.forEach((q, i) => {
      const yMm = topMm + i * slot;
      cards.push(
        `<div class="mcard${right ? ' r' : ''}" style="left:${x}mm;top:${yMm}mm;width:${colW}mm;height:${slot}mm">` +
          `<div class="nm"><i></i>${esc(q.name)}</div>` +
          (q.p.subtitle ? `<div class="st">${esc(q.p.subtitle)}</div>` : '') +
          (q.p.body ? `<p>${esc(q.p.body)}</p>` : '') +
          (q.p.activities ? `<div class="ac"><b>Activities:</b> ${esc(q.p.activities)}</div>` : '') +
          `</div>`,
      );
      anchors.push({ ax: (right ? x : x + colW) * PXMM, ay: (yMm + slot / 2) * PXMM, q });
    });
  };
  layoutCol(leftCol, side, false);
  layoutCol(rightCol, rightX, true);

  // Bent, cased dotted leaders (legible on light margin AND map/country).
  const dash = '5 6';
  const leaders = anchors
    .map(({ ax, ay, q }) => {
      const turnX = ax + (q.px - ax) * 0.62;
      const d = `M${f1(ax)},${f1(ay)} L${f1(turnX)},${f1(ay)} L${f1(q.px)},${f1(q.py)}`;
      return (
        `<path d="${d}" fill="none" stroke="${lineCasing}" stroke-width="4" stroke-dasharray="${dash}" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<path d="${d}" fill="none" stroke="${lineCore}" stroke-width="1.9" stroke-dasharray="${dash}" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<circle cx="${f1(ax)}" cy="${f1(ay)}" r="2.4" fill="${accent}"/>`
      );
    })
    .join('');

  // Faint route through the cities (TRUE positions = geographic truth).
  const ordered = pts.map((q) => [q.tpx, q.tpy] as [number, number]);
  const pl = ordered.map(([x, y]) => `${f1(x)},${f1(y)}`).join(' ');
  const route =
    ordered.length >= 2
      ? `<polyline points="${pl}" fill="none" stroke="${lineCasing}" stroke-width="3.4" stroke-dasharray="2 6" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>` +
        `<polyline points="${pl}" fill="none" stroke="${lineCore}" stroke-width="1.6" stroke-dasharray="2 6" stroke-linecap="round" stroke-linejoin="round"/>`
      : '';

  // In-map name tags ONLY in the single-column case (the card titles + leaders carry the
  // names in the two-column case — removing those redundant tags kills the overprint).
  let labels = '';
  if (!both) {
    const tagH = 15;
    const tags = pts.map((q) => {
      const above = q.py > 16 * PXMM;
      return { q, tx: q.px, ty: q.py + (above ? -11 : 19) };
    });
    tags.sort((u, v) => u.ty - v.ty);
    for (let i = 1; i < tags.length; i++) if (tags[i]!.ty - tags[i - 1]!.ty < tagH) tags[i]!.ty = tags[i - 1]!.ty + tagH;
    labels = tags
      .map(
        (t) =>
          `<text x="${f1(t.tx)}" y="${f1(t.ty)}" text-anchor="middle" paint-order="stroke" ` +
          `stroke="${labelCasing}" stroke-width="3" stroke-linejoin="round" fill="${labelCore}" ` +
          `style="font:700 11px var(--body);letter-spacing:.3px;text-transform:uppercase">${esc(t.q.name.toUpperCase())}</text>`,
      )
      .join('');
  }

  const markers = pts
    .map(
      (q) =>
        `<circle cx="${f1(q.px)}" cy="${f1(q.py)}" r="${markerR}" fill="${mk.fill}" stroke="${mk.ring}" stroke-width="${mk.ringW}"/>` +
        `<circle cx="${f1(q.px)}" cy="${f1(q.py)}" r="2" fill="${mk.dot}"/>`,
    )
    .join('');

  // A thin frame echoes the map window (2D only — the 3D silhouette is its own shape).
  const rx = Math.min(zone.w, zone.h) * 0.035;
  const frame = mode2d
    ? `<rect x="${f1(zone.x)}" y="${f1(zone.y)}" width="${f1(zone.w)}" height="${f1(zone.h)}" rx="${f1(rx)}" fill="none" stroke="${accent}" stroke-width="1.4" opacity=".7"/>`
    : '';

  const svg =
    `<svg class="map__svg" viewBox="0 0 ${f1(W)} ${f1(Hpx)}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">` +
    `${svgPrefix}${frame}${route}${leaders}${markers}${labels}</svg>`;
  return behind + svg + cards.join('');
}

/** Last-resort fallback (no geocoding / no map key): hatched panel + a simple city list. */
function fallbackStage(slice: MapPlace[], a: BandedAssets): string {
  const list = slice
    .map(
      (p) =>
        `<div class="city"><div class="lab"><span class="pin"></span>${esc(p.name)}</div>` +
        (p.subtitle ? `<h3>${esc(p.subtitle)}</h3>` : '') +
        (p.body ? `<p>${esc(p.body)}</p>` : '') +
        (p.activities ? `<div class="acts"><b>Activities:</b> ${esc(p.activities)}</div>` : '') +
        `</div>`,
    )
    .join('');
  const bg = a.map
    ? `<img class="fb__img" src="${esc(a.map)}" alt="Route map">`
    : `<div class="fb__img is-empty">${fallbackMapSvg(slice.length)}</div>`;
  return `${bg}<div class="fb__cities">${list}</div>`;
}

// ---- SECTION measure-and-flow: arbitrary extra sections (flight plan, packing
// list, "why us", FAQ, …) become self-contained .sblock bands that are measured in
// headless Chrome and packed into pages — multiple short sections share a page, a
// long one splits across pages, none ever clip. Mirrors the editorial family so the
// two templates behave identically for extra content.
interface SecBlock {
  id: string;
  html: string;
  hEst: number;
}

const SEC_USABLE = 297; // full-bleed page; .sblock carries its own padding (no page margin)
const SEC_GAP = 9; // paper rhythm between stacked .sblock bands (mm) — matches the .secp-flow flex `gap`
const SEC_SAFETY = 3; // mm cushion → bias to spill onto a new page, never clip
const SEC_HEAD = 26; // .sblock__head (kicker + h2 + padding) estimate, mm
const SEC_HEAD_CONT = 18; // continuation head (no kicker), mm
const SEC_CARD_ROW = 60; // a row of up to 3 cards (54mm figure + gap), mm
const SEC_KV_ROW = 9; // a label→value row, mm
const SEC_LINE = 6; // a wrapped prose/bullet line, mm
const SEC_CARDS_PER_BLOCK = 9; // up to 3 rows of 3 on a page — fits 7–9 cards without a "cont." page
const SEC_KV_PER_BLOCK = 14; // chunk grid items into blocks of ≤14
const SEC_CLEAN = 26; // ≤ this much leftover reads as a clean editorial bottom margin
const SEC_COLO_MIN = 52; // below this, a no-image page just keeps clean margin (no colophon)

/** Trust a measured height, else the conservative estimate (allow legit oversized). */
function sanitizeMeasuredSec(mm: number | undefined, est: number): number {
  if (mm == null || !Number.isFinite(mm) || mm <= 0) return est;
  if (mm > SEC_USABLE * 1.6) return est; // implausibly tall → estimate
  return mm;
}

function sblockHead(s: BrochureSection, cont: boolean): string {
  if (cont) {
    return `<div class="sblock__head cont"><h2>${esc(s.heading || '')} <span class="cont-tag">cont.</span></h2></div>`;
  }
  return (
    `<div class="sblock__head">` +
    (s.kicker ? `<div class="kick">${esc(s.kicker)}</div>` : '') +
    (s.heading ? `<h2>${esc(s.heading)}</h2>` : '') +
    `</div>`
  );
}

/** Build every section as one or more measurable .sblock bands (no content dropped). */
function buildSectionBlocks(c: BrochureContent, a: BandedAssets): SecBlock[] {
  const secs = c.sections ?? [];
  const blocks: SecBlock[] = [];
  secs.forEach((s, idx) => {
    const urls = a.secUrls[idx] ?? [];
    const layout = s.layout ?? (s.cards?.length ? 'cards' : s.items?.length ? 'grid' : 'prose');
    if ((layout === 'cards' || layout === 'gallery') && s.cards?.length) {
      // BALANCED chunking (not fixed slices): 7 cards become ONE page of 7, not 6+1
      // (which stranded a lone card under a redundant "cont." header). A larger set
      // splits into even pages (10 → 5+5, 12 → 6+6) — never a 1-card orphan.
      const chunks = balancedChunk(s.cards, SEC_CARDS_PER_BLOCK);
      let offset = 0;
      chunks.forEach((chunk, ci) => {
        const cont = ci > 0;
        const figs = chunk
          .map((card, j) => {
            const u = urls[offset + j];
            return `<figure>${u ? `<img src="${esc(u)}" alt="">` : ''}<figcaption>${esc(card.label)}${card.caption ? `<small>${esc(card.caption)}</small>` : ''}</figcaption></figure>`;
          })
          .join('');
        const rows = Math.ceil(chunk.length / 3);
        blocks.push({
          id: `sec-${idx}-${offset}`,
          html: `<div class="sblock">${sblockHead(s, cont)}<div class="sblock__body"><div class="secp__cards">${figs}</div></div></div>`,
          hEst: (cont ? SEC_HEAD_CONT : SEC_HEAD) + rows * SEC_CARD_ROW + 8,
        });
        offset += chunk.length;
      });
    } else if (layout === 'grid' && s.items?.length) {
      const items = s.items;
      for (let i = 0; i < items.length; i += SEC_KV_PER_BLOCK) {
        const chunk = items.slice(i, i + SEC_KV_PER_BLOCK);
        const cont = i > 0;
        const kv = chunk.map((row) => `<div class="k">${esc(row.k)}</div><div class="v">${esc(row.v)}</div>`).join('');
        blocks.push({
          id: `sec-${idx}-${i}`,
          html: `<div class="sblock">${sblockHead(s, cont)}<div class="sblock__body"><div class="kv">${kv}</div></div></div>`,
          hEst: (cont ? SEC_HEAD_CONT : SEC_HEAD) + chunk.length * SEC_KV_ROW + 10,
        });
      }
    } else {
      const nb = s.bullets?.length ?? 0;
      // ≥4 bullets flow into two balanced columns (uses the page width instead of a
      // stranded narrow list with dead space to the right); the height estimate then
      // counts only ~half the rows.
      const cols2 = nb >= 4;
      const body =
        (s.body ? `<p>${esc(s.body)}</p>` : '') +
        (nb ? `<ul class="check${cols2 ? ' cols2' : ''}">${s.bullets!.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '');
      // Render whenever the section carries ANYTHING (heading/kicker too) — parity
      // with the editorial family; never silently drop a user-provided section.
      if (!body && !s.heading && !s.kicker) return;
      const bulletLines = cols2 ? Math.ceil(nb / 2) * 1.4 : nb * 1.4;
      const lines = estLines(s.body || '', 165, 13, 0, 0.6) + bulletLines;
      blocks.push({
        id: `sec-${idx}-0`,
        html: `<div class="sblock">${sblockHead(s, false)}<div class="sblock__body">${body}</div></div>`,
        hEst: SEC_HEAD + lines * SEC_LINE + 12,
      });
    }
  });
  return blocks;
}

/** One-column probe doc (full 210mm trim, no network) for measuring section blocks. */
function buildSectionMeasuringHtml(
  blocks: SecBlock[],
  tpl: BrochureTemplate,
  accent: string,
  accent2?: string,
): string {
  const vars = resolveBandedVars(tpl, accent, accent2);
  const probeCss = `.bd-probe{width:210mm;margin:0;padding:0;position:relative}`;
  const body = blocks.map((b) => `<div class="bd-probe" data-ed-id="${b.id}">${stripImgSrc(b.html)}</div>`).join('');
  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">${fontsLinkBanded(tpl.fonts.display, tpl.fonts.body, tpl.coverFont)}` +
    `<style>${vars}${BANDED_CSS}${tpl.css}${probeCss}</style></head><body>${body}</body></html>`
  );
}

/** Close a sparse section page by USING the leftover space, never with a flat colour
 *  box. Preference order: (1) a full-bleed destination photo (real imagery — the user
 *  explicitly asked for images over brand boxes), cycling through the reserved fillers
 *  so consecutive pages differ; (2) failing that, a restrained centred colophon on
 *  paper when the gap is large; (3) otherwise a clean editorial margin. */
function sectionFill(c: BrochureContent, a: BandedAssets, slack: number, _idx: number): string {
  if (slack <= SEC_CLEAN) return ''; // reads as a clean bottom margin
  // Next UNIQUE filler (consumes the cursor only when actually used → never repeated).
  const img = slack >= 34 ? a.fillers[a.fillCursor.i] || '' : '';
  if (img) {
    a.fillCursor.i++;
    // Only caption a tall-enough band (the gradient + padding need room, else it clips).
    const cap = slack >= 56 ? esc(c.tagline || c.__brand?.name || c.agencyName || '') : '';
    return (
      `<div class="secp-photo"><img src="${esc(img)}" alt="">` +
      (cap ? `<div class="secp-photo__cap">${cap}</div>` : '') +
      `</div>`
    );
  }
  if (slack < SEC_COLO_MIN) return ''; // no usable image + modest gap → clean margin
  const mk = esc(c.__brand?.name || c.agencyName || '');
  return `<div class="secp-colo"><div class="secp-colo__rule"></div>${mk ? `<div class="secp-colo__mk">${mk}</div>` : ''}</div>`;
}

/** Greedily pack section blocks into full-bleed pages from real heights; each page
 *  packs from the top and absorbs leftover height into an elastic accent panel, so
 *  pages fill edge-to-edge with no stranded whitespace and nothing ever clips. */
function composeSectionPages(c: BrochureContent, a: BandedAssets, blocks: SecBlock[], hOf: (b: SecBlock) => number, leftMark: boolean): string[] {
  const pages: SecBlock[][] = [];
  let cur: SecBlock[] = [];
  let used = 0;
  for (const b of blocks) {
    const h = hOf(b);
    const gap = cur.length ? SEC_GAP : 0;
    if (cur.length && used + gap + h + SEC_SAFETY > SEC_USABLE) {
      pages.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(b);
    used += (cur.length > 1 ? SEC_GAP : 0) + h;
  }
  if (cur.length) pages.push(cur);

  return pages.map((pg, pi) => {
    const pageUsed = pg.reduce((s, b, i) => s + (i ? SEC_GAP : 0) + hOf(b), 0);
    const oversized = pg.length === 1 && hOf(pg[0]!) > SEC_USABLE;
    const html = pg
      .map((b, i) => (i === 0 && leftMark ? b.html.replace('class="sblock__head', 'class="sblock__head has-mark') : b.html))
      .join('');
    const fill = oversized ? '' : sectionFill(c, a, SEC_USABLE - pageUsed, pi);
    return `<section class="page secp-flow${oversized ? ' secp-flow--over' : ''}">${html}${fill}</section>`;
  });
}

/** Phase: build → (optionally) measure → pack section pages for the banded family. */
async function buildSectionFlowPages(
  c: BrochureContent,
  a: BandedAssets,
  tpl: BrochureTemplate,
  accent: string,
  accent2: string | undefined,
  measure?: EdMeasureFn,
): Promise<string[]> {
  const blocks = buildSectionBlocks(c, a);
  if (!blocks.length) return [];
  let measured: Record<string, number> | null = null;
  if (measure) {
    try {
      measured = await measure(
        buildSectionMeasuringHtml(blocks, tpl, accent, accent2),
        blocks.map((b) => b.id),
      );
    } catch {
      measured = null;
    }
  }
  const hOf = (b: SecBlock) => sanitizeMeasuredSec(measured?.[b.id], b.hEst);
  // ANY top header mark (L/C/R) reserves space below the logo (padding-top pushes the
  // header text down, clear of the logo), not just a left mark.
  return composeSectionPages(c, a, blocks, hOf, wantsBandedRunMark(c));
}

/** Header reserve (mm) for the banded interior logo, scaled to its size. Returns null
 *  for no mark / the small auto mark (which uses the CSS fallback). */
function bandedHeaderReserve(c: BrochureContent): number | null {
  const corner = bandedSafeCorner(runMarkCorner(c));
  const scale = interiorMarkScale(c); // band scale wins over the single mark's
  if (!corner || scale == null) return null;
  // padding-top must clear: top inset (4mm) + logo box (height + ~3mm plate) + ~4mm gap.
  return clampN(round1(4 + customMarkH(scale, corner, 'banded') + 7), 16, 36);
}

function bandedFooter(c: BrochureContent, a: BandedAssets): string {
  const lines = footerContactLines(c).map((l) => esc(l)).join('<br>');
  const social = footerSocials(c)
    .map(
      (s) => `<img src="https://cdn.simpleicons.org/${encodeURIComponent(s.toLowerCase())}/${a.onAccentHex}" alt="">`,
    )
    .join('');
  if (!lines && !social) return '';
  return `<div class="foot"><div class="lines">${lines}</div>${social ? `<div class="soc">${social}</div>` : ''}</div>`;
}

function logisticsPages(c: BrochureContent, a: BandedAssets): string[] {
  // Render ONLY real content — drop empty/placeholder rows so the engine never paints a
  // blank pricing table or empty KV row when the brief omits that info (don't blindly
  // follow the template). A price row is only real if it carries an amount (value).
  const incl = (c.inclusions?.items ?? []).filter((it) => String(it?.k ?? '').trim() || String(it?.v ?? '').trim());
  const price = (c.pricing?.rows ?? []).filter((r) => String(r?.value ?? '').trim());
  const footerHtml = bandedFooter(c, a);
  const hasCta = !!(c.footer && (c.footer.cta || c.footer.checklist?.length || a.qr));
  if (!incl.length && !price.length && !hasCta && !footerHtml) return [];

  const topMark = wantsBandedRunMark(c); // any header logo (L/C/R) → reserve header space

  // Each page draws its own UNIQUE side photo + a flex photo filler that absorbs slack
  // (so a short page reads full, never a void or a flat colour box).
  const sidePhoto = (): string => {
    let lp = a.fillers[a.fillCursor.i] || '';
    if (lp) a.fillCursor.i++;
    else lp = a.hero;
    return `<div class="log__photo">${lp ? `<img src="${esc(lp)}" alt="">` : ''}</div>`;
  };
  const fillPhoto = (): string => {
    const img = a.fillers[a.fillCursor.i] || '';
    if (img) {
      a.fillCursor.i++;
      return `<div class="log__fillphoto"><img src="${esc(img)}" alt=""></div>`;
    }
    return '<div class="log__fill"></div>';
  };
  const page = (colInner: string, footer: string): string =>
    `<section class="page log"><div class="log__col">${colInner}</div>${sidePhoto()}${footer}</section>`;

  // ---- band builders ----
  const inclHeader = (mark: boolean): string =>
    c.inclusions?.kicker || c.inclusions?.heading
      ? `<div class="log__band-accent${mark ? ' has-mark' : ''}">` +
        (c.inclusions?.kicker ? `<div class="kick">${esc(c.inclusions.kicker)}</div>` : '') +
        (c.inclusions?.heading ? `<h2>${esc(c.inclusions.heading)}</h2>` : '') +
        `</div>`
      : '';
  const inclBand = (slice: typeof incl): string =>
    slice.length
      ? `<div class="log__incl"><div class="kv">` +
        slice.map((kv) => `<div class="k">${esc(kv.k)}</div><div class="v">${esc(kv.v)}</div>`).join('') +
        `</div></div>`
      : '';
  const priceBand = (mark: boolean): string => {
    const rows = price
      .map((r) => `<tr class="${r.emphasize ? 'em' : ''}"><td>${esc(r.label)}</td><td class="amt">${esc(r.value)}</td></tr>`)
      .join('');
    return (
      `<div class="log__price${mark ? ' has-mark' : ''}">` +
      (c.pricing?.kicker ? `<div class="kick">${esc(c.pricing.kicker)}</div>` : '') +
      `<h2>${esc(c.pricing?.heading || 'Investment')}</h2>` +
      `<table class="price"><tr><th>Item</th><th>Details</th></tr>${rows}</table>` +
      (c.pricing?.note ? `<div class="pnote">${esc(c.pricing.note)}</div>` : '') +
      `</div>`
    );
  };
  const ctaBand = (): string => {
    const checklist = (c.footer?.checklist ?? []).length
      ? `<ul class="check">${c.footer!.checklist!.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
      : '';
    const ctaH = c.footer?.cta
      ? `<div class="cta-h"><em>${esc(c.footer.cta)}</em>${c.footer.ctaSub ? ` ${esc(c.footer.ctaSub)}` : ''}</div>`
      : '';
    return `<div class="log__cta">${a.qr ? `<div class="qr"><img src="${esc(a.qr)}" alt="QR"></div>` : ''}<div>${ctaH}${checklist}</div></div>`;
  };

  // ---- adaptive pagination by ESTIMATED height (bias tall → spill, never clip) ----
  // A single column can't exceed ~one page; if inclusions + pricing + CTA would overflow,
  // give PRICING its own full page so the table is shown in full (no squeeze, no lost
  // rows). Short content stays on one clean page with a photo filler.
  // Inclusion rows WRAP — a long value ("5 nights premium Makkah hotel within 200m …")
  // spans 2-3 lines, which the old flat `n*13` undercounted → the column overflowed the
  // fixed page and CLIPPED. Estimate each row by its real wrapped line count instead.
  const inclRowMm = (it: { v?: string }) => Math.max(1, Math.ceil(String(it?.v ?? '').length / 34)) * 7 + 5;
  const estIncl = incl.length ? 28 + incl.reduce((s, it) => s + inclRowMm(it), 0) : 0;
  const estPrice = price.length ? 30 + (price.length + 1) * 12 + (c.pricing?.note ? 12 : 0) : 0;
  const estCta = hasCta ? 50 : 0;
  const COL_BUDGET = 225; // mm (reserves footer + safety; biased to split, which never clips)
  const splitPrice = !!(incl.length && price.length && estIncl + estPrice + estCta > COL_BUDGET);

  const pages: string[] = [];

  if (!splitPrice) {
    // Everything fits one page: header + inclusions + pricing + (flex photo) + CTA.
    const cta = hasCta ? ctaBand() : '';
    const col =
      inclHeader(topMark && !!incl.length) +
      inclBand(incl) +
      (price.length ? priceBand(topMark && !incl.length) : '') +
      fillPhoto() +
      cta;
    pages.push(page(col, footerHtml));
    return pages;
  }

  // Split: inclusions page(s) first, then a dedicated pricing+CTA page (the last page).
  // Chunk inclusions by WRAPPED height (not a flat count of 9) so a page of long-value
  // rows can't overflow and clip.
  const chunkInclByHeight = (items: typeof incl): (typeof incl)[] => {
    const PAGE_MM = 235; // usable column height for inclusion rows (minus header/footer/safety)
    const out: (typeof incl)[] = [];
    let cur: typeof incl = [];
    let used = 28; // inclusion header
    for (const it of items) {
      const h = inclRowMm(it);
      if (cur.length && used + h > PAGE_MM) {
        out.push(cur);
        cur = [];
        used = 0;
      }
      cur.push(it);
      used += h;
    }
    if (cur.length) out.push(cur);
    return out.length ? out : [items];
  };
  const inclChunks = incl.length ? chunkInclByHeight(incl) : [];
  inclChunks.forEach((slice, idx) => {
    const col = inclHeader(idx === 0 && topMark) + inclBand(slice) + fillPhoto();
    pages.push(page(col, '')); // footer goes on the final (pricing) page
  });
  pages.push(page(priceBand(topMark) + fillPhoto() + (hasCta ? ctaBand() : ''), footerHtml));
  return pages;
}

async function buildBandedHtml(
  content: BrochureContent,
  tpl: BrochureTemplate,
  measure?: EdMeasureFn,
): Promise<string> {
  const c = content;
  c.__mode = tpl.cover;
  const accent = normalizeAccent(c.__brand?.colors?.accent || c.palette?.accent);
  const accent2 = c.palette?.accentSecondary;

  // ---- gather + fetch assets (parallel, capped) ----
  const hcards = c.highlights?.cards ?? [];
  const secSets = (c.sections ?? []).map((s) => s.cards ?? []);
  const fillerQueries = fillerImageQueries(c);
  // Fetch CANDIDATES per query (parallel — one API call each), then assign a UNIQUE photo
  // to every slot so the same image is never reused anywhere in the brochure.
  const [heroC, hlC, secC, fillC] = await Promise.all([
    searchCandidates(c.heroQuery),
    Promise.all(hcards.map((card) => searchCandidates(card.query))),
    Promise.all(secSets.map((set) => Promise.all(set.map((card) => searchCandidates(card.query))))),
    Promise.all(fillerQueries.map((q) => searchCandidates(q))),
  ]);
  const assign = uniquePhotoAssigner();
  const hero = assign.take(heroC);
  const photos = hlC.map((cands) => assign.take(cands));
  const secUrls = secC.map((set) => set.map((cands) => assign.take(cands)));
  // Unique spare pool for page fillers: dedicated filler scenery first, then the still
  // -unused candidates left over from the content queries (≈5 spares per query).
  fillC.forEach((cands) => assign.addPool(cands));
  assign.addPool(heroC);
  hlC.forEach((cands) => assign.addPool(cands));
  secC.forEach((set) => set.forEach((cands) => assign.addPool(cands)));
  const fillers = assign.pool;

  // Map: geocode the cities ONCE (projection is per-page so leaders point AT the pins).
  // The points feed the default 2D real basemap; the resolved country additionally feeds
  // the opt-in 3D silhouette. `pt.name` keeps the exact key (place.geo || place.name) so
  // map pages match each card to its pin. The raster `map` is only a last-resort fallback
  // (geocoding failed → <2 points), so the page still shows something.
  let geo: BandedAssets['geo'] = null;
  let map = '';
  // Geocode from any route signal (explicit places/cities, else the parsed routeLine)
  // so the annotated map's PINS appear even when the composer under-fills `route`.
  const cityNames = c.route?.places?.length
    ? c.route.places.map((p) => p.geo || p.name)
    : routeCities(c);
  if (cityNames.length >= 2) {
    const { points: pts, country } = await geocodeRoute(cityNames);
    if (pts.length >= 2) {
      geo = { country, points: pts, accent, accentDeep: darken(accent, 0.3), onAccent: contrastInk(accent) };
    } else {
      try {
        map = await routeMapUrl(cityNames, { color: accent.replace('#', ''), width: 900, height: 1200 });
      } catch {
        map = '';
      }
    }
  }
  const qr = brandOrFooterQr(c);

  const a: BandedAssets = { hero, photos, secUrls, fillers, fillCursor: { i: 0 }, geo, map, qr, onAccentHex: contrastInk(accent).replace('#', '') };

  // ---- compose pages (engine-owned order; extra sections flow by MEASURED height
  //      so they pack tight, split across pages, and never clip — same as editorial) ----
  const secFlowPages = await buildSectionFlowPages(c, a, tpl, accent, accent2, measure);
  const pages: string[] = [];
  pages.push(bandedCover(c, a));
  const interior: string[] = [
    ...(await experiencePages(c, a, tpl, accent, accent2, measure)),
    ...mapPages(c, a),
    ...secFlowPages,
    ...logisticsPages(c, a),
  ];
  // Subtle per-page brand running mark (when the placement asks for it). Injected
  // right after each interior page's opening tag — absolute + zero flow height, so
  // it never disturbs the grid. Legible on its own (dark/opaque logo) or on a
  // frosted plate (light logo) over the dark photo rail / accent / ink band each
  // interior page leads with. The MAP page gets it too (the user expects the mark
  // on EVERY page incl. page 3); mapPages suppresses its top-left route label when
  // a running mark is present so the logo owns that corner without collision.
  for (const pageHtml of interior) {
    const mark = bandedRunMark(c);
    pages.push(mark ? pageHtml.replace(/^(<section class="page[^"]*">)/, `$1${mark}`) : pageHtml);
  }

  const vars = resolveBandedVars(tpl, accent, accent2);
  // Scale the header reserve (--hr) to the custom logo size so a bigger header logo
  // pushes the section-header text further down; small/auto marks use the CSS default.
  const hr = bandedHeaderReserve(c);
  const hrVar = hr ? `:root{--hr:${hr}mm}` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">${fontsLinkBanded(
    tpl.fonts.display,
    tpl.fonts.body,
    tpl.coverFont,
  )}<style>${vars}${hrVar}${BANDED_CSS}${tpl.css}</style></head><body>${pages.join('')}</body></html>`;
}
