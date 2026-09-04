"use strict";

// A working reference template for the HTML body renderer.
//
// Serves three purposes:
//   1. The starter an operator gets when they switch a template to HTML mode,
//      so they are editing something real rather than a blank box.
//   2. The few-shot example handed to the AI when it drafts a template from a
//      page image — showing it the available context keys and the expected
//      shape is far more reliable than describing them.
//   3. Executable documentation of the interpolation contract, which is
//      otherwise only implied by buildHtmlContext().
//
// It deliberately reproduces the layout the enum renderer approximated (cover
// hero + uppercase title, black-header schedule table, accent day bands,
// costing page) so the two paths can be compared directly on the same trip.
//
// Available context — see buildHtmlContext() in itineraryTemplatePdf.js:
//   accent, title, subtitle/hasSubtitle, introText, hero/hasHero
//   days[]        label, number, title/hasTitle, route/hasRoute,
//                 learning/hasLearning, items[]
//   days[].items[] time, endTime, hasTime, location/hasLocation, activity
//   inclusions[], exclusions[], otherDetails[], terms[]
//   perPerson, groupTotal, hasPrice
//   fields[]      label, value  (template-specific, for THIS page only)

// Webfonts are the clearest demonstration of what the enum design could not
// express: `typography: "sans" | "serif"` could only ever resolve to
// Helvetica or Times, so a brand set in anything else was unreachable. Only
// fonts.googleapis.com / fonts.gstatic.com are reachable from the renderer.
const STARTER_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap');

body {
  font-family: 'Poppins', Helvetica, Arial, sans-serif;
  font-size: 9pt;
  color: #1a1a1a;
}

/* ---- cover ---- */
.hero { margin: 0 0 14pt; }
.hero img { display: block; width: 100%; height: 232pt; object-fit: cover; }
.cover-title {
  font-size: 21pt;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.2pt;
  line-height: 1.15;
  margin: 0 0 8pt;
}
.cover-intro { font-size: 9.5pt; line-height: 1.55; margin: 0 0 14pt; color: #333; }
.factbar { display: flex; gap: 0; border: 1pt solid var(--accent); }
.fact { flex: 1; padding: 6pt 8pt; border-right: 1pt solid var(--accent); }
.fact:last-child { border-right: 0; }
.fact-l { font-size: 6.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4pt; color: #555; }
.fact-v { font-size: 8.5pt; margin-top: 2pt; }

/* ---- section heading ---- */
.sec { font-size: 15pt; font-weight: 600; margin: 0 0 9pt; }
.sec-a { color: var(--accent); font-weight: 700; }

/* ---- schedule ---- */
.sched { font-size: 8.5pt; }
.sched th {
  background: #000; color: #fff; font-size: 7.5pt; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.6pt; padding: 6pt 4pt; text-align: center;
  border: 0.8pt solid #000;
}
.sched td { border: 0.8pt solid #000; padding: 5pt 7pt; vertical-align: top; }
.t-time { width: 20%; text-align: center; white-space: nowrap; }
.dayband td {
  background: var(--accent); color: #fff; font-weight: 600; font-size: 8.5pt;
  text-transform: uppercase; letter-spacing: 0.5pt; padding: 5pt 8pt; border-color: var(--accent);
}
.dnum { display: inline-block; width: 22%; }
.dttl { font-weight: 500; }
.routerow td { background: #f3f4f6; font-size: 7pt; color: #555; padding: 3pt 8pt; }
.routerow b { color: #333; letter-spacing: 0.4pt; }
.learnrow td { background: #eaf8fb; font-size: 7.5pt; padding: 5pt 8pt; }

/* ---- details ---- */
.price { font-size: 11pt; font-weight: 600; margin: 2pt 0 2pt; }
.price .pp { color: var(--accent); font-weight: 700; }
.grp { font-size: 8pt; color: #667085; margin-bottom: 9pt; }
h3 { font-size: 10pt; font-weight: 600; margin: 11pt 0 4pt; }
ul { margin: 0; padding-left: 13pt; }
li { font-size: 8.5pt; line-height: 1.5; margin-bottom: 2pt; }
li::marker { color: var(--accent); }
`.trim();

// `--accent` is set from the detected/confirmed brand colour, so one
// stylesheet serves every tenant's palette without being rewritten.
const COVER_HTML = `
<div style="--accent: {{accent}}">
  {{#if hasHero}}<div class="hero"><img src="{{hero}}" alt=""></div>{{/if}}
  <h1 class="cover-title">{{title}}</h1>
  {{#if introText}}<p class="cover-intro">{{introText}}</p>{{/if}}
  {{#if fields}}
  <div class="factbar">
    {{#each fields}}<div class="fact"><div class="fact-l">{{label}}</div><div class="fact-v">{{value}}</div></div>{{/each}}
  </div>
  {{/if}}
</div>
`.trim();

const ITINERARY_HTML = `
<div style="--accent: {{accent}}">
  <h2 class="sec"><span class="sec-a">{{title}}</span> Itinerary</h2>
  {{#if hasDays}}
  <table class="sched">
    <thead><tr><th class="t-time">Time</th><th>Activity</th></tr></thead>
    <tbody>
      {{#each days}}
        <tr class="dayband"><td colspan="2"><span class="dnum">{{label}}</span><span class="dttl">{{#if hasTitle}}{{title}}{{else}}Daily Programme{{/if}}</span></td></tr>
        {{#if hasRoute}}<tr class="routerow"><td colspan="2"><b>ROUTE</b> &nbsp;{{route}}</td></tr>{{/if}}
        {{#each items}}
        <tr><td class="t-time">{{time}}</td><td>{{activity}}{{#if hasLocation}} &mdash; {{location}}{{/if}}</td></tr>
        {{/each}}
        {{#if hasLearning}}<tr class="learnrow"><td colspan="2"><b>LEARNING CONNECTION</b><br>{{learning}}</td></tr>{{/if}}
      {{/each}}
    </tbody>
  </table>
  {{else}}
  <p>Day-by-day plan to be confirmed.</p>
  {{/if}}
</div>
`.trim();

const DETAILS_HTML = `
<div style="--accent: {{accent}}">
  <h2 class="sec"><span class="sec-a">Tour Details</span> {{#if hasPrice}}&nbsp;|&nbsp; Costing &amp; Inclusions{{else}}&nbsp;|&nbsp; Inclusions{{/if}}</h2>
  {{#each fields}}<div class="fact-l">{{label}}</div><div class="fact-v" style="margin-bottom:7pt">{{value}}</div>{{/each}}
  {{#if hasPrice}}
  <div class="price"><span class="pp">{{perPerson}}</span> &nbsp;All-inclusive tour cost</div>
  {{#if groupTotal}}<div class="grp">{{groupTotal}}</div>{{/if}}
  {{/if}}
  {{#if inclusions}}<h3>Inclusions</h3><ul>{{#each inclusions}}<li>{{this}}</li>{{/each}}</ul>{{/if}}
  {{#if exclusions}}<h3>Exclusions</h3><ul>{{#each exclusions}}<li>{{this}}</li>{{/each}}</ul>{{/if}}
  {{#if otherDetails}}<h3>Other Details</h3><ul>{{#each otherDetails}}<li>{{this}}</li>{{/each}}</ul>{{/if}}
  {{#if terms}}<h3>Terms &amp; Cancellation</h3><ul>{{#each terms}}<li>{{this}}</li>{{/each}}</ul>{{/if}}
</div>
`.trim();

const STARTER_BY_ROLE = {
  cover: COVER_HTML,
  itinerary: ITINERARY_HTML,
  details: DETAILS_HTML,
};

/**
 * Starter body HTML for a page role, or null for roles that have none
 * (a "static" page is reproduced verbatim and needs no body).
 * @param {string} role
 * @returns {string|null}
 */
function starterHtmlForRole(role) {
  return STARTER_BY_ROLE[role] || null;
}

module.exports = {
  STARTER_CSS,
  COVER_HTML,
  ITINERARY_HTML,
  DETAILS_HTML,
  starterHtmlForRole,
};
