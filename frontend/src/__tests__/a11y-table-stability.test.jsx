/**
 * a11y-table-stability.test.jsx — pinning #632 (icon-only buttons need
 * aria-label) + #633 (table column widths must not jump on row hover).
 *
 * #632 — Screen readers announce icon-only buttons as just "button" with no
 * action context. The sweep added aria-label to row-action buttons (delete,
 * edit), modal close-X buttons, and node-reorder controls across canonical
 * pages. This spec asserts a representative subset of those buttons RENDER
 * with non-empty aria-label, by static-grepping the JSX source — vitest's
 * jsdom can't reliably mount these pages without booting the full data
 * fetcher, so a source-level grep is the deterministic regression pin.
 *
 * #633 — Tables that aren't pinned with table-layout=fixed reflow column
 * widths every time a row hover-state adds inline content (icons revealed,
 * font-weight bumped, padding bumped). The sweep added a `.stable-table`
 * utility class to index.css that pins tableLayout=fixed AND explicitly
 * INHERITS padding/border-width/font-weight on hover (the inherit values
 * stop the row from reflowing on cursor-over). This spec reads index.css
 * directly and asserts the rule is present + the dangerous declarations
 * are absent.
 *
 * Why source-level grep instead of DOM measurement:
 *   - vitest.config.js sets `css: false`, so no real CSS is applied in the
 *     jsdom render — getComputedStyle would return empty strings.
 *   - The contract being pinned is "the CSS rule exists and doesn't
 *     introduce reflow-causing properties on :hover" — that's a static
 *     property of the file, verifiable without a layout engine.
 *   - For the aria-label sweep, mounting the canonical pages requires
 *     mocking AuthContext + fetchApi + 5+ data shapes per page. A source
 *     grep is a strict superset assertion at zero setup cost.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, "..");

function readSrc(...rel) {
  return readFileSync(path.join(SRC_ROOT, ...rel), "utf8");
}

// ── #632 — aria-label on icon-only buttons ──────────────────────────────────
// Each row pins a specific button site that was bare pre-fix. Deliberately
// over-sampled (10 sites) so a future refactor that drops aria-label on any
// of them flips this test red rather than silently regressing screen-reader
// announcement.
const ICON_BUTTON_SITES = [
  // Contacts — row delete + 2 modal close-X
  {
    file: ["pages", "Contacts.jsx"],
    substr: "aria-label={`Delete contact ${contact.name",
  },
  {
    file: ["pages", "Contacts.jsx"],
    substr: 'aria-label="Close import dialog"',
  },
  {
    file: ["pages", "Contacts.jsx"],
    substr: 'aria-label="Close duplicates dialog"',
  },
  // Pipeline — kanban card icons + modal close
  {
    file: ["pages", "Pipeline.jsx"],
    substr: "aria-label={`Generate deal score for",
  },
  {
    file: ["pages", "Pipeline.jsx"],
    substr: "aria-label={`Delete deal ${deal.title}`}",
  },
  {
    file: ["pages", "Pipeline.jsx"],
    substr: 'aria-label="Close deal score dialog"',
  },
  // Invoices — payment modal X
  {
    file: ["pages", "Invoices.jsx"],
    substr: 'aria-label="Close payment dialog"',
  },
  // AbTests — both modal close-X
  {
    file: ["pages", "AbTests.jsx"],
    substr: 'aria-label="Close create A/B test dialog"',
  },
  {
    file: ["pages", "AbTests.jsx"],
    substr: 'aria-label="Close A/B test details"',
  },
  // Currencies — add-currency modal X
  {
    file: ["pages", "Currencies.jsx"],
    substr: 'aria-label="Close add currency dialog"',
  },
  // Territories — territory modal X
  {
    file: ["pages", "Territories.jsx"],
    substr: 'aria-label="Close territory dialog"',
  },
  // LeadRouting — routing rule modal X
  {
    file: ["pages", "LeadRouting.jsx"],
    substr: 'aria-label="Close routing rule dialog"',
  },
  // Chatbots — node-reorder controls (move up/down/remove)
  {
    file: ["pages", "Chatbots.jsx"],
    substr: "aria-label={`Move node ${idx + 1} up`}",
  },
  {
    file: ["pages", "Chatbots.jsx"],
    substr: "aria-label={`Move node ${idx + 1} down`}",
  },
  {
    file: ["pages", "Chatbots.jsx"],
    substr: "aria-label={`Remove node ${idx + 1}`}",
  },
  // CustomReports — filter remove + save modal close
  {
    file: ["pages", "CustomReports.jsx"],
    substr: "aria-label={`Remove filter ${i + 1}`}",
  },
  {
    file: ["pages", "CustomReports.jsx"],
    substr: 'aria-label="Close save report dialog"',
  },
  // Dashboards — widget-remove + generic modal close
  { file: ["pages", "Dashboards.jsx"], substr: 'aria-label="Remove widget"' },
  {
    file: ["pages", "Dashboards.jsx"],
    substr: "aria-label={`Close ${title} dialog`}",
  },
  // wellness/Services — service edit + deactivate. The 815a8783 refactor split
  // Services.jsx into services/*.jsx subcomponents; the per-row edit/deactivate
  // buttons (and their aria-labels) now live in services/ServiceCard.jsx.
  {
    file: ["pages", "wellness", "services", "ServiceCard.jsx"],
    substr: "aria-label={`Edit service ${service.name}`}",
  },
  {
    file: ["pages", "wellness", "services", "ServiceCard.jsx"],
    substr: "aria-label={`Deactivate service ${service.name}`}",
  },
  // #632 follow-up — Surveys + Loyalty (skipped from original sweep due to
  // peer-agent file contention; closed by the wave1-a-aria-632 dispatch).
  // Surveys — send-survey modal X, list-card delete X (per-survey context),
  // create-survey modal X.
  {
    file: ["pages", "Surveys.jsx"],
    substr: 'aria-label="Close send survey dialog"',
  },
  {
    file: ["pages", "Surveys.jsx"],
    substr: "aria-label={`Delete survey ${s.name}`}",
  },
  {
    file: ["pages", "Surveys.jsx"],
    substr: 'aria-label="Close create survey dialog"',
  },
  // wellness/Loyalty — patient-search submit (icon-only Search button).
  {
    file: ["pages", "wellness", "Loyalty.jsx"],
    substr: 'aria-label="Search patients"',
  },
];

describe("#632 — icon-only buttons have aria-label", () => {
  for (const { file, substr } of ICON_BUTTON_SITES) {
    it(`${file.join("/")} — ${substr.slice(0, 60)}…`, () => {
      const src = readSrc(...file);
      expect(src).toContain(substr);
    });
  }

  it('aria-label values are non-empty (no aria-label="" stubs)', () => {
    // Sweep across pages/ for empty-string aria-labels that would defeat
    // screen-reader exposure entirely. Empty aria-label is treated as no
    // accessible name by NVDA/JAWS — this catches the regression where
    // someone added aria-label='' to silence a lint rule.
    for (const { file } of ICON_BUTTON_SITES) {
      const src = readSrc(...file);
      // Match aria-label="" or aria-label={''} or aria-label={``}
      expect(src).not.toMatch(
        /aria-label=(?:""|'\s*'|\{\s*['"`]\s*['"`]\s*\})/,
      );
    }
  });
});

// ── #633 — table-layout fixed + hover-stability CSS rule ────────────────────
describe("#633 — .stable-table CSS contract", () => {
  const css = readSrc("index.css");

  it("declares the .stable-table utility with table-layout: fixed", () => {
    // Use a regex that tolerates whitespace + any property order.
    expect(css).toMatch(/table\.stable-table\s*\{[^}]*table-layout:\s*fixed/);
  });

  it("hover state changes background-color but NOT padding/border-width/font-weight", () => {
    // Extract every rule whose selector contains `.stable-table` AND `:hover`,
    // then assert each rule body uses only safe properties (background,
    // background-color, color, box-shadow, transition) — never the
    // reflow-causing trio.
    const HOVER_RULE_RE = /(table\.stable-table[^{]*:hover[^{]*)\{([^}]*)\}/g;
    const rules = [...css.matchAll(HOVER_RULE_RE)];
    expect(rules.length).toBeGreaterThan(0);

    // For each forbidden property, build a regex that captures the
    // declaration's value and verifies it equals `inherit` (the only
    // safe non-omitted value — anything else reflows the row on hover).
    // Single-line `\s` excludes newlines so we don't accidentally span
    // multiple declarations.
    const FORBIDDEN_HOVER_DECLS = [
      /(?<![\w-])padding[ \t]*:[ \t]*([^;\r\n]+)/g,
      /(?<![\w-])border(?:-(?:top|bottom|left|right))?-width[ \t]*:[ \t]*([^;\r\n]+)/g,
      /(?<![\w-])font-weight[ \t]*:[ \t]*([^;\r\n]+)/g,
      /(?<![\w-])font-size[ \t]*:[ \t]*([^;\r\n]+)/g,
    ];

    for (const [, selector, body] of rules) {
      // Strip CSS comments so the "padding / border-width" mention in the
      // hover-rule's explanatory comment doesn't trip the regex.
      const noComments = body.replace(/\/\*[\s\S]*?\*\//g, "");
      for (const forbidden of FORBIDDEN_HOVER_DECLS) {
        for (const m of noComments.matchAll(forbidden)) {
          const value = m[1].trim();
          expect(
            value,
            `selector "${selector.trim()}" sets ${m[0].split(":")[0].trim()} to "${value}" — must be omitted or "inherit" (reflow-causing on hover)`,
          ).toBe("inherit");
        }
      }
    }
  });

  it("hover transition list excludes width/padding (transition only background/color/shadow)", () => {
    // The transition declaration on .stable-table tbody tr must enumerate
    // properties that don't reflow. A future edit to "transition: all" would
    // re-introduce smooth-but-reflowing animation on hover; pin it out.
    const TR_RULE_RE = /table\.stable-table\s+tbody\s+tr\s*\{([^}]*)\}/;
    const m = css.match(TR_RULE_RE);
    expect(m).not.toBeNull();
    const body = m[1];
    expect(body).toMatch(/transition:[^;]*background-color/);
    expect(body).not.toMatch(/transition:\s*all\b/);
    // padding/border-width/font-weight are not in the transition list
    expect(body).not.toMatch(/transition:[^;]*\bpadding\b/);
    expect(body).not.toMatch(/transition:[^;]*\bborder-width\b/);
    expect(body).not.toMatch(/transition:[^;]*\bfont-weight\b/);
  });
});

describe("#633 — canonical tables adopt .stable-table className", () => {
  // Pin the class onto a representative subset of canonical list pages so
  // a future "tableLayout: auto" regression on any of them is caught.
  const TABLES = [
    {
      file: ["pages", "Contacts.jsx"],
      pattern: /<table\s+className="stable-table"/,
    },
    {
      file: ["pages", "Tickets.jsx"],
      pattern: /<table\s+className="stable-table"/,
    },
    {
      file: ["pages", "Invoices.jsx"],
      // Invoices.jsx splits the tag across lines for the comment block.
      pattern: /<table\s+className="stable-table"/s,
    },
    {
      file: ["pages", "Currencies.jsx"],
      pattern: /<table\s+className="stable-table"/,
    },
    {
      file: ["pages", "Territories.jsx"],
      pattern: /<table\s+className="stable-table"/,
    },
    {
      file: ["pages", "wellness", "Patients.jsx"],
      pattern: /className="stable-table"/,
    },
  ];
  for (const { file, pattern } of TABLES) {
    it(`${file.join("/")} adopts stable-table`, () => {
      const src = readSrc(...file);
      expect(src).toMatch(pattern);
    });
  }
});
